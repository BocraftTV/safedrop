/**
 * UI Logic — wires DOM events to ConnectionManager + FileSender/FileReceiver.
 *
 * Both sender and receiver cards are always visible and independent.
 * Each connection attempt gets its own ConnectionManager instance.
 */

import QRCode from "qrcode";
import { ConnectionManager, type ConnectionRoute } from "./connection.ts";
import { FileSender, FileReceiver, type DownloadableFile, type TransferFileInfo } from "./transfer.ts";

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id) as T | null;
  if (!e) throw new Error(`#${id} not found`);
  return e;
}
function show(id: string) { el(id).hidden = false; }
function hide(id: string) { el(id).hidden = true; }

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

function formatEta(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

function setProgress(barId: string, labelId: string, ratio: number, extra?: string): void {
  const pct = Math.round(ratio * 100);
  const bar = el(barId);
  bar.style.width = `${pct}%`;
  bar.setAttribute("aria-valuenow", String(pct));
  el(labelId).textContent = extra ? `${pct}% — ${extra}` : `${pct}%`;
}

function progressText(done: number, total: number, bps: number): string {
  const eta = bps > 0 && done < total ? ` — noch ${formatEta((total - done) / bps)}` : "";
  return `${formatBytes(done)} / ${formatBytes(total)} — ${formatSpeed(bps)}${eta}`;
}

function setStatus(el: HTMLElement, text: string, type: "ok" | "loading" | "error"): void {
  el.textContent = text;
  el.className = `status ${type}`;
  el.hidden = false;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function showRoute(id: string, route: ConnectionRoute): void {
  const e = el(id);
  if (route === "relay") {
    e.textContent = "🔁 Über TURN-Relay — keine Direktverbindung möglich, Daten werden verschlüsselt über Cloudflare weitergeleitet";
    e.className = "route-info relay";
  } else {
    e.textContent = "⚡ Direktverbindung zwischen den Geräten";
    e.className = "route-info direct";
  }
  e.hidden = false;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderFileList(files: { name: string; size: number }[]): string {
  const totalSize = files.reduce((n, f) => n + f.size, 0);
  return files
    .map(f => `<div class="file-item"><span class="file-name">${esc(f.name)}</span><span class="file-size">${formatBytes(f.size)}</span></div>`)
    .join("") + `<p class="file-total">Gesamt: ${formatBytes(totalSize)}</p>`;
}

// ── Page lifecycle guards ─────────────────────────────────────────────────────

/** Reasons the page shouldn't be closed right now (transfer running, files not saved). */
const busy = new Set<string>();

window.addEventListener("beforeunload", (e) => {
  if (busy.size) e.preventDefault();
});

/** Keep the screen on during a transfer — mobile browsers kill WebRTC in the background. */
class ScreenWakeLock {
  private lock: WakeLockSentinel | null = null;
  private wanted = false;

  constructor() {
    document.addEventListener("visibilitychange", () => {
      if (this.wanted && document.visibilityState === "visible") void this.acquire();
    });
  }

  async acquire(): Promise<void> {
    this.wanted = true;
    if (this.lock || !("wakeLock" in navigator)) return;
    try {
      this.lock = await navigator.wakeLock.request("screen");
      this.lock.addEventListener("release", () => { this.lock = null; });
    } catch { /* not allowed (e.g. low battery) — ignore */ }
  }

  release(): void {
    this.wanted = false;
    void this.lock?.release();
    this.lock = null;
  }
}

// ── App init ──────────────────────────────────────────────────────────────────

export function initApp(): void {
  initSenderCard();
  initReceiverCard();
}

// ── Sender card ───────────────────────────────────────────────────────────────

function initSenderCard(): void {
  let mgr: ConnectionManager | null = null;
  let selectedFiles: File[] = [];
  let activeSender: FileSender | null = null;
  let currentShareUrl = "";
  const wakeLock = new ScreenWakeLock();

  // File selection
  const dropZone = el<HTMLDivElement>("drop-zone");
  const fileInput = el<HTMLInputElement>("file-input");
  const cancelBtn = el<HTMLButtonElement>("btn-cancel-sender");

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer?.files.length) handleFiles(Array.from(e.dataTransfer.files));
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) handleFiles(Array.from(fileInput.files));
  });

  function handleFiles(files: File[]): void {
    selectedFiles = files;
    const list = el("file-list");
    list.innerHTML = renderFileList(files);
    list.hidden = false;
    el<HTMLButtonElement>("btn-connect-sender").disabled = false;
  }

  el("btn-connect-sender").addEventListener("click", async () => {
    if (!selectedFiles.length) return;
    el<HTMLButtonElement>("btn-connect-sender").disabled = true;

    mgr?.disconnect();
    const m = new ConnectionManager();
    mgr = m;
    m.onStateChange = (state, detail) => {
      if (mgr !== m) return;
      if (state === "webrtc") setStatus(el("sender-status"), "Empfänger gefunden — baue Direktverbindung auf...", "loading");
      if (state === "error") showSenderError(detail ?? "Verbindungsfehler");
    };
    m.onChannelOpen = (channels) => { if (mgr === m) startSending(channels); };
    m.onRouteChange = (route) => { if (mgr === m) showRoute("sender-route", route); };
    m.onPeerDisconnected = () => {
      if (mgr === m && busy.has("send")) showSenderError("Verbindung zum Empfänger verloren");
    };

    hide("sender-step-files");
    show("sender-step-code");
    el("share-code").textContent = "······";
    hide("qr-wrap-inner");
    setStatus(el("sender-status"), "Verbinde mit Server...", "loading");

    try {
      await m.startAsSender((code) => {
        el("share-code").textContent = code;
        setStatus(el("sender-status"), "Warte auf Empfänger...", "loading");
        currentShareUrl = `${window.location.origin}${window.location.pathname}?code=${code}`;
        show("qr-wrap-inner");
        void QRCode.toCanvas(el<HTMLCanvasElement>("qr-canvas"), currentShareUrl, {
          width: 200,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
      });
    } catch (err) {
      if (mgr === m) showSenderError(errMsg(err));
    }
  });

  function showSenderError(message: string): void {
    busy.delete("send");
    wakeLock.release();
    if (!el("sender-step-transfer").hidden) {
      setStatus(el("sender-connection-status"), `❌ ${message}`, "error");
      cancelBtn.textContent = "↺ Neue Übertragung";
    } else {
      setStatus(el("sender-status"), `❌ ${message}`, "error");
      hide("qr-wrap-inner");
      el("share-code").textContent = "";
      el("btn-sender-retry").textContent = "↺ Zurück";
    }
  }

  el("btn-sender-retry").addEventListener("click", () => {
    mgr?.disconnect();
    mgr = null;
    el("btn-sender-retry").textContent = "✕ Abbrechen";
    hide("sender-step-code");
    show("sender-step-files");
    el<HTMLButtonElement>("btn-connect-sender").disabled = selectedFiles.length === 0;
  });

  el("share-code").addEventListener("click", () => {
    const code = el("share-code").textContent ?? "";
    if (!/^[a-z0-9]{6}$/.test(code)) return;
    navigator.clipboard.writeText(code).then(() => {
      el("share-code").textContent = "Kopiert!";
      setTimeout(() => { el("share-code").textContent = code; }, 1400);
    });
  });

  el("btn-copy-link").addEventListener("click", () => {
    if (!currentShareUrl) return;
    navigator.clipboard.writeText(currentShareUrl).then(() => {
      const btn = el("btn-copy-link");
      const orig = btn.textContent;
      btn.textContent = "Kopiert!";
      setTimeout(() => { btn.textContent = orig; }, 1400);
    });
  });

  cancelBtn.addEventListener("click", () => {
    activeSender?.cancel();
    mgr?.disconnect();
    mgr = null;
    resetSenderCard();
  });

  function startSending(channels: RTCDataChannel[]): void {
    hide("sender-step-code");
    show("sender-step-transfer");
    cancelBtn.textContent = "✕ Abbrechen";
    busy.add("send");
    void wakeLock.acquire();

    const connStatus = el("sender-connection-status");
    setStatus(connStatus, "🔒 Verbunden — tausche Schlüssel aus...", "loading");
    setProgress("sender-progress-bar", "sender-progress-label", 0, "Warte auf Empfänger...");

    const sender = new FileSender(channels);
    activeSender = sender;

    sender.onKeyFingerprint = (fp) => {
      el("sender-sas-emoji").textContent = fp;
      show("sender-sas");
    };

    sender.onWaitingForAccept = () => {
      setStatus(connStatus, "Warte, bis der Empfänger den Sicherheitscode bestätigt...", "loading");
    };

    sender.onAccepted = () => {
      setStatus(connStatus, "🔒 Bestätigt — Übertragung läuft (Ende-zu-Ende verschlüsselt)", "ok");
    };

    sender.onProgress = (done, total, bps) => {
      setProgress("sender-progress-bar", "sender-progress-label", done / total, progressText(done, total, bps));
    };

    sender.onDone = () => {
      busy.delete("send");
      wakeLock.release();
      setProgress("sender-progress-bar", "sender-progress-label", 1, "Übertragung abgeschlossen ✓");
      setStatus(connStatus, "✅ Alle Dateien übertragen und vom Empfänger verifiziert", "ok");
      cancelBtn.textContent = "↺ Neue Übertragung";
      mgr?.disconnect();
      mgr = null;
    };

    sender.onError = (e) => showSenderError(e.message);

    sender.start(selectedFiles).catch(() => { /* reported via onError */ });
  }

  function resetSenderCard(): void {
    activeSender = null;
    busy.delete("send");
    wakeLock.release();
    show("sender-step-files");
    hide("sender-step-code");
    hide("sender-step-transfer");
    el("btn-sender-retry").textContent = "✕ Abbrechen";
    el("sender-sas-emoji").textContent = "";
    el("sender-sas").hidden = true;
    hide("sender-route");
    cancelBtn.textContent = "✕ Abbrechen";
    fileInput.value = "";
    const list = el("file-list");
    list.innerHTML = "";
    list.hidden = true;
    el<HTMLButtonElement>("btn-connect-sender").disabled = true;
    selectedFiles = [];
  }
}

// ── Receiver card ─────────────────────────────────────────────────────────────

function initReceiverCard(): void {
  let mgr: ConnectionManager | null = null;
  let activeReceiver: FileReceiver | null = null;
  let objectUrls: string[] = [];
  const wakeLock = new ScreenWakeLock();

  const codeInput = el<HTMLInputElement>("code-input");
  const connectBtn = el<HTMLButtonElement>("btn-connect-receiver");
  const cancelBtn = el<HTMLButtonElement>("btn-cancel-receiver");
  const statusEl = el("receiver-status");

  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toLowerCase().replace(/[^a-z0-9]/g, "");
    statusEl.hidden = true;
  });
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connectBtn.click();
  });

  connectBtn.addEventListener("click", async () => {
    const code = codeInput.value.trim();
    if (!/^[a-z0-9]{6}$/.test(code)) {
      setStatus(statusEl, "Bitte einen 6-stelligen Code eingeben.", "error");
      return;
    }
    connectBtn.disabled = true;
    codeInput.disabled = true;
    setStatus(statusEl, "Verbinde mit Server...", "loading");

    mgr?.disconnect();
    const m = new ConnectionManager();
    mgr = m;
    m.onStateChange = (state, detail) => {
      if (mgr !== m) return;
      if (state === "webrtc") setStatus(statusEl, "Baue Direktverbindung zum Sender auf...", "loading");
      if (state === "error") showReceiverError(detail ?? "Verbindungsfehler");
    };
    m.onChannelOpen = (channels) => { if (mgr === m) startReceiving(channels); };
    m.onRouteChange = (route) => { if (mgr === m) showRoute("receiver-route", route); };
    m.onPeerDisconnected = () => {
      if (mgr === m && busy.has("receive")) showReceiverError("Verbindung zum Sender verloren");
    };

    try {
      await m.startAsReceiver(code);
    } catch (err) {
      if (mgr === m) showReceiverError(errMsg(err));
    }
  });

  function showReceiverError(message: string): void {
    busy.delete("receive");
    wakeLock.release();
    if (!el("receiver-step-transfer").hidden) {
      setStatus(el("receiver-connection-status"), `❌ ${message}`, "error");
      hide("receiver-confirm");
      cancelBtn.textContent = "↺ Neue Übertragung";
    } else {
      setStatus(statusEl, `❌ ${message}`, "error");
      connectBtn.disabled = false;
      codeInput.disabled = false;
    }
  }

  cancelBtn.addEventListener("click", () => {
    if (busy.has("download") &&
        !confirm("Die empfangenen Dateien gehen verloren, wenn du sie nicht gespeichert hast. Trotzdem schließen?")) {
      return;
    }
    activeReceiver?.cancel(el("receiver-confirm").hidden ? "Empfänger hat abgebrochen" : "Empfänger hat abgelehnt");
    mgr?.disconnect();
    mgr = null;
    resetReceiverCard();
  });

  el("btn-accept-transfer").addEventListener("click", () => {
    hide("receiver-confirm");
    show("receiver-progress");
    cancelBtn.textContent = "✕ Abbrechen";
    setStatus(el("receiver-connection-status"), "🔒 Übertragung läuft (Ende-zu-Ende verschlüsselt)", "ok");
    setProgress("receiver-progress-bar", "receiver-progress-label", 0, "Warte auf Daten...");
    activeReceiver?.accept();
  });

  function startReceiving(channels: RTCDataChannel[]): void {
    hide("receiver-step-code");
    show("receiver-step-transfer");
    cancelBtn.textContent = "✕ Abbrechen";
    busy.add("receive");
    void wakeLock.acquire();

    const connStatus = el("receiver-connection-status");
    setStatus(connStatus, "🔒 Verbunden — tausche Schlüssel aus...", "loading");

    const receiver = new FileReceiver(channels);
    activeReceiver = receiver;

    receiver.onKeyFingerprint = (fp) => {
      el("receiver-sas-emoji").textContent = fp;
      show("receiver-sas");
    };

    receiver.onHeaderReceived = (files: TransferFileInfo[]) => {
      el("receiver-incoming-files").innerHTML = renderFileList(files);
      setStatus(connStatus, "🔒 Verbunden — bitte Sicherheitscode vergleichen", "ok");
      cancelBtn.textContent = "✕ Ablehnen";
      show("receiver-confirm");
    };

    receiver.onProgress = (done, total, bps) => {
      setProgress("receiver-progress-bar", "receiver-progress-label", done / total, progressText(done, total, bps));
    };

    receiver.onFilesReady = (files: DownloadableFile[]) => {
      busy.delete("receive");
      busy.add("download");
      wakeLock.release();
      setProgress("receiver-progress-bar", "receiver-progress-label", 1, "✓ Empfangen & verifiziert");
      setStatus(connStatus, "✅ Integrität bestätigt — jetzt speichern!", "ok");
      cancelBtn.textContent = "↺ Neue Übertragung";
      showDownloads(files);
      mgr?.disconnect();
      mgr = null;
    };

    receiver.onError = (e) => showReceiverError(e.message);

    receiver.receive().catch(() => { /* reported via onError */ });
  }

  function showDownloads(files: DownloadableFile[]): void {
    const area = el("download-area");
    area.innerHTML = `<p class="download-hint">Die Dateien existieren nur in diesem Tab — speichere sie, bevor du ihn schließt.</p>`;

    for (const file of files) {
      const url = URL.createObjectURL(file.blob);
      objectUrls.push(url);

      const row = document.createElement("div");
      row.className = "download-row";
      row.innerHTML = `
        <span class="file-name">${esc(file.name)}</span>
        <span class="download-actions">
          <a class="download-btn" href="${url}" download="${esc(file.name)}">⬇ Speichern</a>
        </span>
      `;
      row.querySelector("a")!.addEventListener("click", () => busy.delete("download"));

      // iOS/Android: the share sheet offers "In Dateien sichern" / "Bild sichern",
      // which is more reliable on mobile than a blob download.
      const shareFile = new File([file.blob], file.name, { type: file.mimeType });
      if (navigator.canShare?.({ files: [shareFile] })) {
        const btn = document.createElement("button");
        btn.className = "share-btn";
        btn.textContent = "📤 Teilen";
        btn.addEventListener("click", () => {
          navigator.share({ files: [shareFile] })
            .then(() => busy.delete("download"))
            .catch((e: unknown) => {
              if (e instanceof DOMException && e.name === "AbortError") return;
              console.warn("share failed", e);
            });
        });
        row.querySelector(".download-actions")!.appendChild(btn);
      }

      area.appendChild(row);
    }

    area.hidden = false;
  }

  function resetReceiverCard(): void {
    activeReceiver = null;
    busy.delete("receive");
    busy.delete("download");
    wakeLock.release();
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
    show("receiver-step-code");
    hide("receiver-step-transfer");
    el("receiver-confirm").hidden = true;
    el("receiver-progress").hidden = true;
    el("receiver-sas-emoji").textContent = "";
    el("receiver-sas").hidden = true;
    hide("receiver-route");
    el("receiver-incoming-files").innerHTML = "";
    cancelBtn.textContent = "✕ Abbrechen";
    codeInput.value = "";
    codeInput.disabled = false;
    connectBtn.disabled = false;
    statusEl.hidden = true;
    const area = el("download-area");
    area.innerHTML = "";
    area.hidden = true;
  }

  // Opened via QR code / shared link → connect right away
  const urlCode = new URLSearchParams(window.location.search).get("code");
  if (urlCode) {
    history.replaceState(null, "", window.location.pathname); // a reload shouldn't reuse the code
    codeInput.value = urlCode.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
    if (codeInput.value.length === 6) connectBtn.click();
  }
}
