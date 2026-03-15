/**
 * UI Logic — wires DOM events to ConnectionManager + FileSender/FileReceiver.
 */

import QRCode from "qrcode";
import { ConnectionManager, type AppState } from "./connection.ts";
import { FileSender, FileReceiver, type DownloadableFile, type TransferFileInfo } from "./transfer.ts";

// ── Module-level transfer refs (needed by cancel + confirm handlers) ──────────

let _activeSender: FileSender | null = null;
let _activeReceiver: FileReceiver | null = null;

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
  const i = Math.floor(Math.log(bytes) / Math.log(k));
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

function setStatus(el: HTMLElement, text: string, type: "ok" | "loading" | "error"): void {
  el.textContent = text;
  el.className = `status ${type}`;
  el.hidden = false;
}

// ── App init ──────────────────────────────────────────────────────────────────

export function initApp(): void {
  const mgr = new ConnectionManager();
  let selectedFiles: File[] = [];
  let isSenderMode = false;

  // ── Mode selection ──────────────────────────────────────────────────────────

  el("btn-sender").addEventListener("click", () => {
    isSenderMode = true;
    hide("mode-select");
    show("sender-view");
  });

  el("btn-receiver").addEventListener("click", () => {
    isSenderMode = false;
    hide("mode-select");
    show("receiver-view");
  });

  el("sender-back").addEventListener("click", () => {
    _activeSender?.cancel();
    mgr.disconnect();
    resetSender();
    hide("sender-view");
    show("mode-select");
  });

  el("receiver-back").addEventListener("click", () => {
    _activeReceiver?.cancel();
    mgr.disconnect();
    resetReceiver();
    hide("receiver-view");
    show("mode-select");
  });

  // ── Cancel buttons ──────────────────────────────────────────────────────────

  el("btn-cancel-sender").addEventListener("click", () => {
    _activeSender?.cancel();
    mgr.disconnect();
    resetSender();
    hide("sender-view");
    show("mode-select");
  });

  el("btn-cancel-receiver").addEventListener("click", () => {
    _activeReceiver?.cancel();
    mgr.disconnect();
    resetReceiver();
    hide("receiver-view");
    show("mode-select");
  });

  // ── Receiver confirmation ───────────────────────────────────────────────────

  el("btn-accept-transfer").addEventListener("click", () => {
    hide("receiver-confirm");
    show("receiver-progress");
    _activeReceiver?.confirm();
  });

  // ── State change ────────────────────────────────────────────────────────────

  mgr.onStateChange = (state: AppState, detail?: string) => {
    if (state === "webrtc") {
      if (isSenderMode) {
        setStatus(el("sender-status"), "Baut Verbindung auf...", "loading");
      }
    }
    if (state === "error") {
      const msg = `❌ ${detail ?? "Verbindungsfehler"}`;
      if (isSenderMode) {
        setStatus(el("sender-status"), msg, "error");
        show("sender-step-code");
      } else {
        setStatus(el("receiver-error"), msg, "error");
      }
    }
  };

  mgr.onChannelOpen = (channel) => {
    if (isSenderMode) {
      hide("sender-step-code");
      show("sender-step-transfer");
      startSending(channel, selectedFiles);
    } else {
      hide("receiver-step-code");
      show("receiver-step-transfer");
      startReceiving(channel);
    }
  };

  // ── Sender: file selection ──────────────────────────────────────────────────

  const dropZone = el<HTMLDivElement>("drop-zone");
  const fileInput = el<HTMLInputElement>("file-input");

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
    const totalSize = files.reduce((n, f) => n + f.size, 0);
    list.innerHTML = files
      .map(f => `<div class="file-item"><span class="file-name">${esc(f.name)}</span><span class="file-size">${formatBytes(f.size)}</span></div>`)
      .join("") + `<p class="file-total">Gesamt: ${formatBytes(totalSize)}</p>`;
    list.hidden = false;
    el<HTMLButtonElement>("btn-connect-sender").disabled = false;
  }

  el("btn-connect-sender").addEventListener("click", async () => {
    if (!selectedFiles.length) return;
    el<HTMLButtonElement>("btn-connect-sender").disabled = true;

    try {
      await mgr.startAsSender((code) => {
        hide("sender-step-files");
        show("sender-step-code");
        el("share-code").textContent = code;
        setStatus(el("sender-status"), "Warte auf Empfänger...", "loading");
        // QR code — non-critical, fire-and-forget
        void QRCode.toCanvas(el<HTMLCanvasElement>("qr-canvas"), code, {
          width: 200,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
        });
      });
    } catch (err) {
      setStatus(el("sender-status"), `❌ ${err instanceof Error ? err.message : String(err)}`, "error");
      show("sender-step-code");
      hide("sender-step-files");
    }
  });

  el("share-code").addEventListener("click", () => {
    const code = el("share-code").textContent ?? "";
    navigator.clipboard.writeText(code).then(() => {
      const orig = el("share-code").textContent;
      el("share-code").textContent = "Kopiert!";
      setTimeout(() => { el("share-code").textContent = orig; }, 1400);
    });
  });

  // ── Receiver: enter code ────────────────────────────────────────────────────

  const codeInput = el<HTMLInputElement>("code-input");

  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toLowerCase().replace(/[^a-z0-9]/g, "");
    el("receiver-error").hidden = true;
  });
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el("btn-connect-receiver").click();
  });

  el("btn-connect-receiver").addEventListener("click", async () => {
    const code = codeInput.value.trim();
    if (code.length !== 6) {
      setStatus(el("receiver-error"), "Bitte einen 6-stelligen Code eingeben.", "error");
      return;
    }
    el<HTMLButtonElement>("btn-connect-receiver").disabled = true;
    hide("receiver-error");

    try {
      await mgr.startAsReceiver(code);
    } catch (err) {
      setStatus(el("receiver-error"), `❌ ${err instanceof Error ? err.message : String(err)}`, "error");
      el<HTMLButtonElement>("btn-connect-receiver").disabled = false;
    }
  });
}

// ── Transfer: Sender ──────────────────────────────────────────────────────────

function startSending(channel: RTCDataChannel, files: File[]): void {
  const connStatus = el("sender-connection-status");
  setStatus(connStatus, "🔒 Verbunden — E2E verschlüsselt", "ok");

  const sender = new FileSender(channel);
  _activeSender = sender;

  sender.onKeyFingerprint = (fp) => {
    el("sender-sas-emoji").textContent = fp;
    show("sender-sas");
  };

  sender.onProgress = (done, total, bps) => {
    const eta = bps > 0 && done < total ? ` — noch ${formatEta((total - done) / bps)}` : "";
    setProgress(
      "sender-progress-bar", "sender-progress-label",
      done / total,
      `${formatBytes(done)} / ${formatBytes(total)} — ${formatSpeed(bps)}${eta}`,
    );
  };

  sender.onDone = () => {
    setProgress("sender-progress-bar", "sender-progress-label", 1, "Übertragung abgeschlossen ✓");
    setStatus(connStatus, "✅ Alle Dateien übertragen und verifiziert", "ok");
    hide("btn-cancel-sender");
  };

  sender.onError = (e) => {
    setStatus(connStatus, `❌ ${e.message}`, "error");
    hide("btn-cancel-sender");
  };

  sender.start(files);
}

// ── Transfer: Receiver ────────────────────────────────────────────────────────

function startReceiving(channel: RTCDataChannel): void {
  const connStatus = el("receiver-connection-status");
  setStatus(connStatus, "🔒 Verbunden — warte auf Dateien...", "ok");

  const receiver = new FileReceiver(channel);
  _activeReceiver = receiver;
  receiver.requireConfirmation = true;

  receiver.onKeyFingerprint = (fp) => {
    el("receiver-sas-emoji").textContent = fp;
    show("receiver-sas");
  };

  receiver.onHeaderReceived = (files: TransferFileInfo[]) => {
    const list = el("receiver-incoming-files");
    const totalSize = files.reduce((n, f) => n + f.size, 0);
    list.innerHTML = files
      .map(f => `<div class="file-item"><span class="file-name">${esc(f.name)}</span><span class="file-size">${formatBytes(f.size)}</span></div>`)
      .join("") + `<p class="file-total">Gesamt: ${formatBytes(totalSize)}</p>`;
    show("receiver-confirm");
  };

  receiver.onProgress = (done, total, bps) => {
    const eta = bps > 0 && done < total ? ` — noch ${formatEta((total - done) / bps)}` : "";
    setProgress(
      "receiver-progress-bar", "receiver-progress-label",
      done / total,
      `${formatBytes(done)} / ${formatBytes(total)} — ${formatSpeed(bps)}${eta}`,
    );
  };

  receiver.onFilesReady = (files: DownloadableFile[]) => {
    setProgress("receiver-progress-bar", "receiver-progress-label", 1, "✓ Empfangen & verifiziert");
    setStatus(connStatus, "✅ Integrität bestätigt (Merkle root stimmt überein)", "ok");
    hide("btn-cancel-receiver");
    showDownloads(files);
  };

  receiver.onError = (e) => {
    setStatus(connStatus, `❌ ${e.message}`, "error");
    hide("btn-cancel-receiver");
  };

  receiver.receive();
}

function showDownloads(files: DownloadableFile[]): void {
  const area = el("download-area");
  area.innerHTML = "";

  for (const file of files) {
    const url = URL.createObjectURL(file.blob);
    const row = document.createElement("div");
    row.className = "download-row";
    row.innerHTML = `
      <span class="file-name">${esc(file.name)}</span>
      <a class="download-btn" href="${url}" download="${esc(file.name)}">⬇ Download</a>
    `;
    area.appendChild(row);
  }

  area.hidden = false;
}

// ── Reset helpers ─────────────────────────────────────────────────────────────

function resetSender(): void {
  _activeSender = null;
  show("sender-step-files");
  hide("sender-step-code");
  hide("sender-step-transfer");
  el("sender-sas-emoji").textContent = "";
  el("sender-sas").hidden = true;
  el("btn-cancel-sender").hidden = false;
  const input = document.getElementById("file-input") as HTMLInputElement;
  if (input) input.value = "";
  const list = document.getElementById("file-list");
  if (list) { list.innerHTML = ""; list.hidden = true; }
  const btn = document.getElementById("btn-connect-sender") as HTMLButtonElement;
  if (btn) btn.disabled = true;
}

function resetReceiver(): void {
  _activeReceiver = null;
  show("receiver-step-code");
  hide("receiver-step-transfer");
  el("receiver-confirm").hidden = true;
  el("receiver-progress").hidden = true;
  el("receiver-sas-emoji").textContent = "";
  el("receiver-sas").hidden = true;
  el("receiver-incoming-files").innerHTML = "";
  el("btn-cancel-receiver").hidden = false;
  const input = document.getElementById("code-input") as HTMLInputElement;
  if (input) input.value = "";
  const btn = document.getElementById("btn-connect-receiver") as HTMLButtonElement;
  if (btn) btn.disabled = false;
  const err = document.getElementById("receiver-error");
  if (err) err.hidden = true;
  const area = document.getElementById("download-area");
  if (area) { area.innerHTML = ""; area.hidden = true; }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
