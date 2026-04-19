/**
 * SecureDrop File Transfer Protocol
 *
 * Binary message protocol over WebRTC DataChannel:
 *
 *   MSG_PUBKEY (0x01)  [32 B pubkey]
 *   MSG_HEADER (0x02)  [32 B salt][JSON: {files:[{name,size,mimeType,chunkCount}]}]
 *   MSG_CHUNK  (0x03)  [4 B chunk_idx LE][4 B file_idx LE][N B ciphertext]
 *   MSG_DONE   (0x04)  [32 B merkle_root]
 *   MSG_ACK    (0x05)  (empty payload)
 *   MSG_ERROR  (0x06)  [UTF-8 error message]
 *
 * Key exchange happens over the DataChannel (protected by WebRTC DTLS):
 *   1. Sender sends pubkey → Receiver sends pubkey
 *   2. Both compute X25519 ECDH → HKDF-SHA256 → enc_key + nonce_seed
 *   3. Every chunk encrypted with ChaCha20-Poly1305, unique nonce per chunk
 *   4. Receiver verifies Merkle root before ACK
 */

import { getCryptoModule } from "./crypto.ts";
import { waitForBufferDrain } from "./webrtc.ts";

const CHUNK_SIZE = 128 * 1024; // 128 KiB — Chrome DataChannel max message size is 256 KiB; after
// encryption (+16 B auth tag) and protocol header (+9 B), 256 KiB plaintext exceeds that limit.

// ── Message types ────────────────────────────────────────────────────────────

const enum MsgType {
  PUBKEY = 0x01,
  HEADER = 0x02,
  CHUNK  = 0x03,
  DONE   = 0x04,
  ACK    = 0x05,
  ERROR  = 0x06,
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface TransferFileInfo {
  name: string;
  size: number;
  mimeType: string;
  chunkCount: number;
}

export interface DownloadableFile {
  name: string;
  mimeType: string;
  blob: Blob;
}

export type ProgressCallback = (transferred: number, total: number, speedBps: number) => void;

// ── Binary helpers ────────────────────────────────────────────────────────────

function pack(type: MsgType, ...parts: Uint8Array[]): ArrayBuffer {
  const size = 1 + parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  out[0] = type;
  let offset = 1;
  for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
  return out.buffer;
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function readU32le(b: Uint8Array, offset: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint32(offset, true);
}

// ── SAS fingerprint ───────────────────────────────────────────────────────────
//
// Derives 4 emoji from SHA-256(sharedSecret).
// Both peers compute the same value — showing them side-by-side lets users
// verify that no MITM is present (Short Authentication String).

const SAS_EMOJI = [
  "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮",
  "🐷","🐸","🐵","🐔","🐧","🐦","🐤","🦆","🦅","🦉","🦇","🐺",
  "🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🐜","🦟","🦗","🦂",
  "🐢","🐍","🦎","🦖","🦕","🐙","🦑","🦐","🦞","🦀","🐡","🐟",
  "🐠","🐬","🐳","🐋","🦈","🐊","🐅","🐆","🦓","🦍","🦧","🐘",
  "🦛","🦏","🐪","🐫",
];

async function computeFingerprint(sharedSecret: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", sharedSecret as BufferSource));
  // 3 bytes → 24 bits → 4 × 6-bit indices into the 64-emoji table
  const b = (hash[0] << 16) | (hash[1] << 8) | hash[2];
  return [
    SAS_EMOJI[(b >> 18) & 0x3f],
    SAS_EMOJI[(b >> 12) & 0x3f],
    SAS_EMOJI[(b >> 6)  & 0x3f],
    SAS_EMOJI[b         & 0x3f],
  ].join(" ");
}

// ── Sequential message queue ──────────────────────────────────────────────────

class MsgQueue {
  private buf: ArrayBuffer[] = [];
  private waiters: Array<{ type: MsgType; resolve: (p: Uint8Array) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  push(data: ArrayBuffer): void {
    const view = new Uint8Array(data);
    const msgType = view[0] as MsgType;

    const idx = this.waiters.findIndex(w => w.type === msgType);
    if (idx >= 0) {
      const [w] = this.waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(view.slice(1));
    } else {
      this.buf.push(data);
    }
  }

  expect(type: MsgType, timeoutMs = 15_000): Promise<Uint8Array> {
    const idx = this.buf.findIndex(d => new Uint8Array(d)[0] === type);
    if (idx >= 0) {
      const [d] = this.buf.splice(idx, 1);
      return Promise.resolve(new Uint8Array(d).slice(1));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex(w => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`Transfer timeout waiting for message 0x${type.toString(16)}`));
      }, timeoutMs);

      this.waiters.push({ type, resolve, reject, timer });
    });
  }
}

// ── FileSender ────────────────────────────────────────────────────────────────

export class FileSender {
  onProgress: ProgressCallback | null = null;
  onDone: (() => void) | null = null;
  onError: ((e: Error) => void) | null = null;
  /** Called with 4 emoji once the shared key is derived — same value on both sides. */
  onKeyFingerprint: ((emoji: string) => void) | null = null;

  private queue = new MsgQueue();
  private cancelled = false;
  private readonly channels: RTCDataChannel[];
  private readonly ctrl: RTCDataChannel; // channel 0 — control messages

  constructor(channels: RTCDataChannel[]) {
    this.channels = channels;
    this.ctrl = channels[0];
    // Only control messages (PUBKEY, ACK, ERROR) arrive from the receiver
    this.ctrl.onmessage = (e) => this.queue.push(e.data as ArrayBuffer);
  }

  cancel(): void {
    this.cancelled = true;
  }

  async start(files: File[]): Promise<void> {
    try {
      await this._run(files);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!this.cancelled) {
        try { this.ctrl.send(pack(MsgType.ERROR, new TextEncoder().encode(e.message))); } catch { /* ignore */ }
      }
      this.onError?.(e);
      throw e;
    }
  }

  private async _run(files: File[]): Promise<void> {
    const wasm = getCryptoModule();
    const { channels, ctrl } = this;
    const chanCount = channels.length;

    // ── 1. Key exchange ──────────────────────────────────────────────────────
    const keypair = new wasm.Keypair();
    ctrl.send(pack(MsgType.PUBKEY, new Uint8Array(keypair.publicKey)));

    const theirPk = await this.queue.expect(MsgType.PUBKEY);
    const sharedSecret = new Uint8Array(keypair.diffieHellman(theirPk));

    // SAS fingerprint (both sides compute same value)
    const fp = await computeFingerprint(sharedSecret);
    this.onKeyFingerprint?.(fp);

    const salt = crypto.getRandomValues(new Uint8Array(32));
    const km = new Uint8Array(wasm.deriveKeyMaterial(sharedSecret, salt));
    const encKey   = km.slice(0, 32);
    const nonceSeed = km.slice(32, 44);

    // ── 2. Header ────────────────────────────────────────────────────────────
    const infos: TransferFileInfo[] = files.map(f => ({
      name: f.name,
      size: f.size,
      mimeType: f.type || "application/octet-stream",
      chunkCount: f.size === 0 ? 1 : Math.ceil(f.size / CHUNK_SIZE),
    }));
    const headerJson = new TextEncoder().encode(JSON.stringify(infos));
    ctrl.send(pack(MsgType.HEADER, salt, headerJson));

    // ── 3. Chunks — round-robin across all DataChannels ──────────────────────
    const totalBytes = Math.max(files.reduce((n, f) => n + f.size, 0), 1);
    let bytesDone = 0;
    const leafHashes: Uint8Array[] = [];
    const t0 = performance.now();
    let ci = 0;

    // Chrome's File API has a large fixed overhead per arrayBuffer() call (~5–35 ms),
    // independent of how many bytes are read. Reading in 4 MiB blocks instead of
    // 128 KiB chunks reduces calls by 32× and amortises that cost.
    // The next block is prefetched while the current one is being encrypted/sent.
    const READ_BLOCK = 4 * 1024 * 1024;

    for (let fi = 0; fi < files.length; fi++) {
      if (this.cancelled) throw new Error("Transfer abgebrochen");
      const file = files[fi];

      if (file.size === 0) {
        // Empty file: send one empty chunk so receiver's chunkCount stays consistent
        const empty = new Uint8Array(0);
        const cipher = new Uint8Array(wasm.encryptChunk(encKey, nonceSeed, ci, empty));
        leafHashes.push(new Uint8Array(wasm.hashChunk(empty, ci)));
        const ch = channels[ci % chanCount];
        await waitForBufferDrain(ch);
        ch.send(pack(MsgType.CHUNK, u32le(ci), u32le(fi), cipher));
        ci++;
        continue;
      }

      let pendingBlock = file.slice(0, READ_BLOCK).arrayBuffer();

      for (let blockStart = 0; blockStart < file.size; blockStart += READ_BLOCK) {
        if (this.cancelled) throw new Error("Transfer abgebrochen");

        const blockBuf = new Uint8Array(await pendingBlock);

        // Prefetch next block in the background while we process this one
        const nextStart = blockStart + READ_BLOCK;
        if (nextStart < file.size) {
          pendingBlock = file.slice(nextStart, nextStart + READ_BLOCK).arrayBuffer();
        }

        for (let off = 0; off < blockBuf.byteLength; off += CHUNK_SIZE) {
          if (this.cancelled) throw new Error("Transfer abgebrochen");

          const plain  = blockBuf.subarray(off, off + CHUNK_SIZE);
          const cipher = new Uint8Array(wasm.encryptChunk(encKey, nonceSeed, ci, plain));
          leafHashes.push(new Uint8Array(wasm.hashChunk(plain, ci)));

          const ch = channels[ci % chanCount];
          await waitForBufferDrain(ch);
          ch.send(pack(MsgType.CHUNK, u32le(ci), u32le(fi), cipher));

          bytesDone += plain.byteLength;
          ci++;
          const secs = (performance.now() - t0) / 1000;
          this.onProgress?.(bytesDone, totalBytes, secs > 0 ? bytesDone / secs : 0);
        }
      }
    }

    // ── 4. Done — send Merkle root, wait for ACK ─────────────────────────────
    const root = new Uint8Array(wasm.computeMerkleRoot(leafHashes));
    ctrl.send(pack(MsgType.DONE, root));
    await this.queue.expect(MsgType.ACK, 30_000);

    this.onDone?.();
  }
}

// ── FileReceiver ──────────────────────────────────────────────────────────────

export class FileReceiver {
  onProgress: ProgressCallback | null = null;
  onFilesReady: ((files: DownloadableFile[]) => void) | null = null;
  onError: ((e: Error) => void) | null = null;
  /** Fired as soon as the header arrives — use to update the UI with file names. */
  onHeaderReceived: ((files: TransferFileInfo[]) => void) | null = null;
  /** Called with 4 emoji once the shared key is derived — same value on both sides. */
  onKeyFingerprint: ((emoji: string) => void) | null = null;

  /** Set to true to pause after onHeaderReceived until confirm() is called. */
  requireConfirmation = false;

  private queue = new MsgQueue();
  private cancelled = false;
  private confirmResolve: (() => void) | null = null;
  private readonly ctrl: RTCDataChannel; // channel 0 — control messages

  constructor(channels: RTCDataChannel[]) {
    this.ctrl = channels[0];
    // Chunks arrive on ANY channel, control messages on channel 0 → feed all into one queue
    for (const ch of channels) {
      ch.onmessage = (e) => this.queue.push(e.data as ArrayBuffer);
    }
  }

  /** Call after onHeaderReceived to start receiving chunks. */
  confirm(): void {
    this.confirmResolve?.();
  }

  cancel(): void {
    this.cancelled = true;
    this.confirmResolve?.(); // unblock confirmation wait if pending
  }

  async receive(): Promise<void> {
    try {
      await this._run();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.onError?.(e);
      throw e;
    }
  }

  private async _run(): Promise<void> {
    const wasm = getCryptoModule();

    // ── 1. Key exchange ──────────────────────────────────────────────────────
    const senderPk = await this.queue.expect(MsgType.PUBKEY);
    const keypair  = new wasm.Keypair();
    this.ctrl.send(pack(MsgType.PUBKEY, new Uint8Array(keypair.publicKey)));

    const sharedSecret = new Uint8Array(keypair.diffieHellman(senderPk));

    // ── 2. Header ────────────────────────────────────────────────────────────
    const headerRaw = await this.queue.expect(MsgType.HEADER);
    const salt       = headerRaw.slice(0, 32);
    const infos: TransferFileInfo[] = JSON.parse(new TextDecoder().decode(headerRaw.slice(32)));

    const km = new Uint8Array(wasm.deriveKeyMaterial(sharedSecret, salt));
    const encKey    = km.slice(0, 32);
    const nonceSeed = km.slice(32, 44);

    // SAS fingerprint
    const fp = await computeFingerprint(sharedSecret);
    this.onKeyFingerprint?.(fp);

    this.onHeaderReceived?.(infos);

    // Wait for user confirmation (chunks are buffered by MsgQueue in the meantime)
    if (this.requireConfirmation) {
      await new Promise<void>(resolve => { this.confirmResolve = resolve; });
      if (this.cancelled) throw new Error("Transfer abgebrochen");
    }

    // ── 3. Receive + decrypt chunks ──────────────────────────────────────────
    const totalChunks = infos.reduce((n, f) => n + f.chunkCount, 0);
    const totalBytes  = Math.max(infos.reduce((n, f) => n + f.size, 0), 1);

    const allChunks = new Map<number, Uint8Array>();
    const leafHashes: Uint8Array[] = new Array(totalChunks);

    let bytesDone = 0;
    const t0 = performance.now();

    for (let received = 0; received < totalChunks; received++) {
      if (this.cancelled) throw new Error("Transfer abgebrochen");

      const raw      = await this.queue.expect(MsgType.CHUNK, 60_000);
      const chunkIdx = readU32le(raw, 0);
      const cipher   = raw.slice(8); // skip file_idx too (bytes 4-7)

      const plain = new Uint8Array(wasm.decryptChunk(encKey, nonceSeed, chunkIdx, cipher));
      allChunks.set(chunkIdx, plain);
      leafHashes[chunkIdx] = new Uint8Array(wasm.hashChunk(plain, chunkIdx));

      bytesDone += plain.byteLength;
      const secs = (performance.now() - t0) / 1000;
      this.onProgress?.(bytesDone, totalBytes, secs > 0 ? bytesDone / secs : 0);
    }

    // ── 4. Verify Merkle root ────────────────────────────────────────────────
    const donePayload = await this.queue.expect(MsgType.DONE, 10_000);
    const senderRoot  = donePayload.slice(0, 32);
    const ourRoot     = new Uint8Array(wasm.computeMerkleRoot(leafHashes));

    if (!senderRoot.every((b, i) => b === ourRoot[i])) {
      this.ctrl.send(pack(MsgType.ERROR, new TextEncoder().encode("Merkle root mismatch")));
      throw new Error("Integritätsfehler — Merkle root stimmt nicht überein");
    }

    // ── 5. Assemble files + send ACK ─────────────────────────────────────────
    this.ctrl.send(pack(MsgType.ACK));

    let startChunk = 0;
    const downloads: DownloadableFile[] = infos.map(info => {
      const parts: Uint8Array[] = [];
      for (let ci = 0; ci < info.chunkCount; ci++) {
        const chunk = allChunks.get(startChunk + ci);
        if (chunk) parts.push(chunk);
      }
      startChunk += info.chunkCount;
      return {
        name: info.name,
        mimeType: info.mimeType,
        blob: new Blob(parts as BlobPart[], { type: info.mimeType }),
      };
    });

    this.onFilesReady?.(downloads);
  }
}
