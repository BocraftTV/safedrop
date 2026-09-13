/**
 * SecureDrop File Transfer Protocol
 *
 * Binary message protocol over WebRTC DataChannels (channel 0 = ordered control channel):
 *
 *   MSG_PUBKEY (0x01)  [32 B pubkey]
 *   MSG_HEADER (0x02)  [32 B salt][JSON: [{name,size,mimeType,chunkCount}]]
 *   MSG_CHUNK  (0x03)  [4 B chunk_idx LE][4 B file_idx LE][N B ciphertext]
 *   MSG_DONE   (0x04)  [32 B merkle_root]
 *   MSG_ACK    (0x05)  (empty payload)
 *   MSG_ERROR  (0x06)  [UTF-8 error message] — aborts the transfer on the other side
 *   MSG_COMMIT (0x07)  [32 B SHA-256(sender pubkey)]
 *   MSG_ACCEPT (0x08)  (empty payload) — receiver verified the security code and accepted
 *
 * Handshake (hash commitment prevents a MITM from brute-forcing a matching security code):
 *   1. Sender → COMMIT(H(pk_s))
 *   2. Receiver → PUBKEY(pk_r)
 *   3. Sender → PUBKEY(pk_s); receiver checks H(pk_s) against the commitment
 *   4. Both: X25519 ECDH → HKDF-SHA256 → enc_key + nonce_seed; SAS = 4 emoji
 *   5. Sender → HEADER; receiver shows files + SAS and waits for the user
 *   6. Receiver → ACCEPT; only now does the sender start sending chunks
 *   7. Sender → CHUNKs + DONE(merkle root); receiver verifies → ACK
 */

import { getCryptoModule } from "./crypto.ts";
import { waitForBufferDrain } from "./webrtc.ts";

const CHUNK_SIZE = 128 * 1024; // 128 KiB — Chrome DataChannel max message size is 256 KiB; after
// encryption (+16 B auth tag) and protocol header (+9 B), 256 KiB plaintext exceeds that limit.

/** Receiver flushes decrypted chunks into a Blob every this many bytes to bound JS heap usage. */
const FLUSH_BYTES = 32 * 1024 * 1024;

// ── Message types ────────────────────────────────────────────────────────────

const enum MsgType {
  PUBKEY = 0x01,
  HEADER = 0x02,
  CHUNK  = 0x03,
  DONE   = 0x04,
  ACK    = 0x05,
  ERROR  = 0x06,
  COMMIT = 0x07,
  ACCEPT = 0x08,
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

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) { joined.set(p, off); off += p.byteLength; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined as BufferSource));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// ── SAS fingerprint ───────────────────────────────────────────────────────────
//
// 4 emoji derived from SHA-256(label ‖ sharedSecret ‖ pk_sender ‖ pk_receiver).
// Both peers compute the same value — comparing them lets users verify that no
// MITM is present (Short Authentication String). The commitment in the handshake
// ensures an attacker gets only one 1-in-2^24 guess.

const SAS_EMOJI = [
  "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮",
  "🐷","🐸","🐵","🐔","🐧","🐦","🐤","🦆","🦅","🦉","🦇","🐺",
  "🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🐜","🦟","🦗","🦂",
  "🐢","🐍","🦎","🦖","🦕","🐙","🦑","🦐","🦞","🦀","🐡","🐟",
  "🐠","🐬","🐳","🐋","🦈","🐊","🐅","🐆","🦓","🦍","🦧","🐘",
  "🦛","🦏","🐪","🐫",
];

async function computeFingerprint(sharedSecret: Uint8Array, pkSender: Uint8Array, pkReceiver: Uint8Array): Promise<string> {
  const label = new TextEncoder().encode("safedrop-sas-v2");
  const hash = await sha256(label, sharedSecret, pkSender, pkReceiver);
  // 3 bytes → 24 bits → 4 × 6-bit indices into the 64-emoji table
  const b = (hash[0] << 16) | (hash[1] << 8) | hash[2];
  return [
    SAS_EMOJI[(b >> 18) & 0x3f],
    SAS_EMOJI[(b >> 12) & 0x3f],
    SAS_EMOJI[(b >> 6)  & 0x3f],
    SAS_EMOJI[b         & 0x3f],
  ].join(" ");
}

// ── Message queue ─────────────────────────────────────────────────────────────

interface Waiter {
  resolve: (p: Uint8Array) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Buffers incoming messages per type and hands them out via expect().
 * An ERROR message from the peer or a closed channel fails all pending and future expects.
 */
class MsgQueue {
  private buf = new Map<MsgType, Uint8Array[]>();
  private waiters = new Map<MsgType, Waiter[]>();
  private failure: Error | null = null;

  push(data: ArrayBuffer): void {
    const view = new Uint8Array(data);
    const type = view[0] as MsgType;
    const payload = view.subarray(1);

    if (type === MsgType.ERROR) {
      this.fail(new Error(`Gegenseite: ${new TextDecoder().decode(payload) || "Fehler"}`));
      return;
    }

    const w = this.waiters.get(type)?.shift();
    if (w) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve(payload);
    } else {
      let list = this.buf.get(type);
      if (!list) this.buf.set(type, list = []);
      list.push(payload);
    }
  }

  /** Resolve with the next message of `type`. timeoutMs = 0 waits forever. */
  expect(type: MsgType, timeoutMs = 30_000): Promise<Uint8Array> {
    if (this.failure) return Promise.reject(this.failure);

    const buffered = this.buf.get(type)?.shift();
    if (buffered) return Promise.resolve(buffered);

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const list = this.waiters.get(type);
          const i = list?.indexOf(waiter) ?? -1;
          if (i >= 0) list!.splice(i, 1);
          reject(new Error("Keine Antwort vom anderen Gerät — bitte beide Seiten neu laden und erneut versuchen"));
        }, timeoutMs);
      }
      let list = this.waiters.get(type);
      if (!list) this.waiters.set(type, list = []);
      list.push(waiter);
    });
  }

  fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.buf.clear();
    for (const list of this.waiters.values()) {
      for (const w of list) {
        if (w.timer) clearTimeout(w.timer);
        w.reject(err);
      }
    }
    this.waiters.clear();
  }
}

// ── Shared base ───────────────────────────────────────────────────────────────

abstract class TransferPeer {
  onError: ((e: Error) => void) | null = null;
  /** Called with 4 emoji once the shared key is derived — same value on both sides. */
  onKeyFingerprint: ((emoji: string) => void) | null = null;

  protected queue = new MsgQueue();
  protected cancelled = false;
  protected finished = false;
  protected readonly channels: RTCDataChannel[];
  protected readonly ctrl: RTCDataChannel; // channel 0 — control messages

  constructor(channels: RTCDataChannel[]) {
    this.channels = channels;
    this.ctrl = channels[0];
    for (const ch of channels) {
      ch.onmessage = (e) => this.queue.push(e.data as ArrayBuffer);
      ch.addEventListener("close", () => {
        if (!this.finished) this.queue.fail(new Error("Verbindung zum anderen Gerät unterbrochen"));
      });
    }
  }

  /** Abort the transfer and tell the peer why. */
  cancel(reason = "Übertragung abgebrochen"): void {
    if (this.cancelled || this.finished) return;
    this.cancelled = true;
    this.sendError(reason);
    this.queue.fail(new Error("Transfer abgebrochen"));
  }

  protected sendError(message: string): void {
    try {
      if (this.ctrl.readyState === "open") this.ctrl.send(pack(MsgType.ERROR, new TextEncoder().encode(message)));
    } catch { /* ignore */ }
  }

  protected async runGuarded(run: () => Promise<void>): Promise<void> {
    try {
      await run();
      this.finished = true;
    } catch (err) {
      const e = toError(err);
      this.finished = true;
      if (!this.cancelled) {
        this.sendError(e.message);
        this.onError?.(e);
      }
      throw e;
    }
  }

  protected checkCancelled(): void {
    if (this.cancelled) throw new Error("Transfer abgebrochen");
  }
}

// ── FileSender ────────────────────────────────────────────────────────────────

export class FileSender extends TransferPeer {
  onProgress: ProgressCallback | null = null;
  onDone: (() => void) | null = null;
  /** Header sent — waiting for the receiver to compare the security code and accept. */
  onWaitingForAccept: (() => void) | null = null;
  /** Receiver accepted — chunks are about to be sent. */
  onAccepted: (() => void) | null = null;

  start(files: File[]): Promise<void> {
    return this.runGuarded(() => this._run(files));
  }

  private async _run(files: File[]): Promise<void> {
    const wasm = getCryptoModule();
    const { channels, ctrl } = this;
    const chanCount = channels.length;

    // ── 1. Key exchange with commitment ──────────────────────────────────────
    const keypair = new wasm.Keypair();
    const ourPk = new Uint8Array(keypair.publicKey);
    ctrl.send(pack(MsgType.COMMIT, await sha256(ourPk)));

    const theirPk = await this.queue.expect(MsgType.PUBKEY);
    ctrl.send(pack(MsgType.PUBKEY, ourPk));

    const sharedSecret = new Uint8Array(keypair.diffieHellman(theirPk));
    keypair.free();

    this.onKeyFingerprint?.(await computeFingerprint(sharedSecret, ourPk, theirPk));

    const salt = crypto.getRandomValues(new Uint8Array(32));
    const km = new Uint8Array(wasm.deriveKeyMaterial(sharedSecret, salt));
    const encKey    = km.slice(0, 32);
    const nonceSeed = km.slice(32, 44);

    // ── 2. Header, then wait for the receiver to accept ──────────────────────
    const infos: TransferFileInfo[] = files.map(f => ({
      name: f.name,
      size: f.size,
      mimeType: f.type || "application/octet-stream",
      chunkCount: f.size === 0 ? 1 : Math.ceil(f.size / CHUNK_SIZE),
    }));
    const headerJson = new TextEncoder().encode(JSON.stringify(infos));
    ctrl.send(pack(MsgType.HEADER, salt, headerJson));

    this.onWaitingForAccept?.();
    await this.queue.expect(MsgType.ACCEPT, 0);
    this.checkCancelled();
    this.onAccepted?.();

    // ── 3. Chunks — round-robin across all DataChannels ──────────────────────
    const totalBytes = Math.max(files.reduce((n, f) => n + f.size, 0), 1);
    let bytesDone = 0;
    const leafHashes: Uint8Array[] = [];
    const t0 = performance.now();
    let ci = 0;

    // Progress counts bytes that actually left the send buffers, not just bytes queued.
    const reportProgress = () => {
      const buffered = channels.reduce((n, ch) => n + ch.bufferedAmount, 0);
      const sent = Math.max(0, bytesDone - buffered);
      const secs = (performance.now() - t0) / 1000;
      this.onProgress?.(sent, totalBytes, secs > 0 ? sent / secs : 0);
    };

    // Chrome's File API has a large fixed overhead per arrayBuffer() call (~5–35 ms),
    // independent of how many bytes are read. Reading in 4 MiB blocks instead of
    // 128 KiB chunks reduces calls by 32× and amortises that cost.
    // The next block is prefetched while the current one is being encrypted/sent.
    const READ_BLOCK = 4 * 1024 * 1024;

    for (let fi = 0; fi < files.length; fi++) {
      this.checkCancelled();
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
        this.checkCancelled();

        const blockBuf = new Uint8Array(await pendingBlock);

        // Prefetch next block in the background while we process this one
        const nextStart = blockStart + READ_BLOCK;
        if (nextStart < file.size) {
          pendingBlock = file.slice(nextStart, nextStart + READ_BLOCK).arrayBuffer();
        }

        for (let off = 0; off < blockBuf.byteLength; off += CHUNK_SIZE) {
          this.checkCancelled();

          const plain  = blockBuf.subarray(off, off + CHUNK_SIZE);
          const cipher = new Uint8Array(wasm.encryptChunk(encKey, nonceSeed, ci, plain));
          leafHashes.push(new Uint8Array(wasm.hashChunk(plain, ci)));

          const ch = channels[ci % chanCount];
          await waitForBufferDrain(ch);
          ch.send(pack(MsgType.CHUNK, u32le(ci), u32le(fi), cipher));

          bytesDone += plain.byteLength;
          ci++;
          reportProgress();
        }
      }
    }

    // ── 4. Done — send Merkle root, wait for ACK ─────────────────────────────
    const root = new Uint8Array(wasm.computeMerkleRoot(leafHashes));
    ctrl.send(pack(MsgType.DONE, root));

    // Keep the progress bar moving while the send buffers drain
    const drainTimer = setInterval(reportProgress, 250);
    try {
      await this.queue.expect(MsgType.ACK, 5 * 60_000);
    } finally {
      clearInterval(drainTimer);
    }

    this.finished = true;
    this.onDone?.();
  }
}

// ── FileReceiver ──────────────────────────────────────────────────────────────

export class FileReceiver extends TransferPeer {
  onProgress: ProgressCallback | null = null;
  onFilesReady: ((files: DownloadableFile[]) => void) | null = null;
  /** Fired once the header arrives — show file list + security code, then call accept(). */
  onHeaderReceived: ((files: TransferFileInfo[]) => void) | null = null;

  private acceptResolve: (() => void) | null = null;
  private accepted = false;

  /** User compared the security code and accepts the files. */
  accept(): void {
    this.accepted = true;
    this.acceptResolve?.();
  }

  override cancel(reason = "Empfänger hat abgebrochen"): void {
    super.cancel(reason);
    this.acceptResolve?.(); // unblock confirmation wait if pending
  }

  receive(): Promise<void> {
    return this.runGuarded(() => this._run());
  }

  private async _run(): Promise<void> {
    const wasm = getCryptoModule();

    // ── 1. Key exchange with commitment ──────────────────────────────────────
    const commitment = await this.queue.expect(MsgType.COMMIT);
    const keypair = new wasm.Keypair();
    const ourPk = new Uint8Array(keypair.publicKey);
    this.ctrl.send(pack(MsgType.PUBKEY, ourPk));

    const senderPk = await this.queue.expect(MsgType.PUBKEY);
    if (!bytesEqual(await sha256(senderPk), commitment)) {
      keypair.free();
      throw new Error("Schlüsselaustausch manipuliert — Verbindung nicht sicher");
    }

    const sharedSecret = new Uint8Array(keypair.diffieHellman(senderPk));
    keypair.free();

    this.onKeyFingerprint?.(await computeFingerprint(sharedSecret, senderPk, ourPk));

    // ── 2. Header ────────────────────────────────────────────────────────────
    const headerRaw = await this.queue.expect(MsgType.HEADER);
    const salt  = headerRaw.slice(0, 32);
    const infos = parseHeader(headerRaw.subarray(32));

    const km = new Uint8Array(wasm.deriveKeyMaterial(sharedSecret, salt));
    const encKey    = km.slice(0, 32);
    const nonceSeed = km.slice(32, 44);

    this.onHeaderReceived?.(infos);

    // ── 3. Wait for the user, then tell the sender to start ──────────────────
    if (!this.accepted) {
      await new Promise<void>(resolve => { this.acceptResolve = resolve; });
    }
    this.checkCancelled();
    this.ctrl.send(pack(MsgType.ACCEPT));

    // ── 4. Receive + decrypt chunks, assemble files incrementally ────────────
    const totalChunks = infos.reduce((n, f) => n + f.chunkCount, 0);
    const totalBytes  = Math.max(infos.reduce((n, f) => n + f.size, 0), 1);
    const assembler   = new FileAssembler(infos);
    const leafHashes: Uint8Array[] = new Array(totalChunks);

    let bytesDone = 0;
    const t0 = performance.now();

    for (let received = 0; received < totalChunks; received++) {
      this.checkCancelled();

      const raw      = await this.queue.expect(MsgType.CHUNK, 60_000);
      const chunkIdx = readU32le(raw, 0);
      if (chunkIdx >= totalChunks || leafHashes[chunkIdx]) {
        throw new Error(`Ungültiger Chunk-Index ${chunkIdx}`);
      }

      const plain = new Uint8Array(wasm.decryptChunk(encKey, nonceSeed, chunkIdx, raw.subarray(8)));
      leafHashes[chunkIdx] = new Uint8Array(wasm.hashChunk(plain, chunkIdx));
      assembler.add(chunkIdx, plain);

      bytesDone += plain.byteLength;
      const secs = (performance.now() - t0) / 1000;
      this.onProgress?.(bytesDone, totalBytes, secs > 0 ? bytesDone / secs : 0);
    }

    // ── 5. Verify Merkle root ────────────────────────────────────────────────
    const donePayload = await this.queue.expect(MsgType.DONE, 60_000);
    const ourRoot     = new Uint8Array(wasm.computeMerkleRoot(leafHashes));

    if (!bytesEqual(donePayload.subarray(0, 32), ourRoot)) {
      throw new Error("Integritätsfehler — Merkle root stimmt nicht überein");
    }

    // ── 6. ACK + hand files to the UI ────────────────────────────────────────
    this.finished = true;
    this.ctrl.send(pack(MsgType.ACK));
    this.onFilesReady?.(assembler.finish());
  }
}

function parseHeader(raw: Uint8Array): TransferFileInfo[] {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Ungültiger Header");
  return parsed.map((f) => {
    const { name, size, mimeType, chunkCount } = f as Record<string, unknown>;
    if (typeof name !== "string" || typeof mimeType !== "string" ||
        !Number.isSafeInteger(size) || (size as number) < 0 ||
        chunkCount !== ((size as number) === 0 ? 1 : Math.ceil((size as number) / CHUNK_SIZE))) {
      throw new Error("Ungültiger Header");
    }
    return { name, size: size as number, mimeType, chunkCount };
  });
}

/**
 * Reassembles out-of-order chunks into per-file Blobs.
 * Contiguous chunks are flushed into Blob segments regularly so decrypted data
 * doesn't pile up as thousands of small ArrayBuffers on the JS heap.
 */
class FileAssembler {
  private pending = new Map<number, Uint8Array>();
  private nextIdx = 0;
  private fileIdx = 0;
  private fileEnd: number;
  private segment: Uint8Array[] = [];
  private segmentBytes = 0;
  private fileParts: Blob[] = [];
  private done: DownloadableFile[] = [];

  constructor(private readonly infos: TransferFileInfo[]) {
    this.fileEnd = infos[0].chunkCount;
  }

  add(idx: number, plain: Uint8Array): void {
    this.pending.set(idx, plain);
    let chunk: Uint8Array | undefined;
    while ((chunk = this.pending.get(this.nextIdx)) !== undefined) {
      this.pending.delete(this.nextIdx);
      this.nextIdx++;
      if (chunk.byteLength) {
        this.segment.push(chunk);
        this.segmentBytes += chunk.byteLength;
        if (this.segmentBytes >= FLUSH_BYTES) this.flushSegment();
      }
      if (this.nextIdx === this.fileEnd) this.finishFile();
    }
  }

  finish(): DownloadableFile[] {
    if (this.done.length !== this.infos.length) throw new Error("Unvollständige Übertragung");
    return this.done;
  }

  private flushSegment(): void {
    if (!this.segment.length) return;
    this.fileParts.push(new Blob(this.segment as BlobPart[]));
    this.segment = [];
    this.segmentBytes = 0;
  }

  private finishFile(): void {
    this.flushSegment();
    const info = this.infos[this.fileIdx];
    this.done.push({
      name: info.name,
      mimeType: info.mimeType,
      blob: new Blob(this.fileParts, { type: info.mimeType }),
    });
    this.fileParts = [];
    this.fileIdx++;
    if (this.fileIdx < this.infos.length) this.fileEnd += this.infos[this.fileIdx].chunkCount;
  }
}
