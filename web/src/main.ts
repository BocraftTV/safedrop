/**
 * SecureDrop — App Entry Point
 *
 * 1. Load + verify WASM crypto-core
 * 2. Hand off to UI
 */

import { initCrypto, getCryptoModule } from "./crypto.ts";
import { initApp } from "./ui.ts";

async function main(): Promise<void> {
  const loadingEl = document.getElementById("wasm-loading") as HTMLDivElement;

  try {
    await initCrypto();

    // Quick sanity check
    const wasm = getCryptoModule();
    if (wasm.smokeTestAdd(1, 1) !== 2) throw new Error("WASM smoke test failed");

    loadingEl.hidden = true;

    // Show the app
    const modeEl = document.getElementById("mode-select") as HTMLElement;
    modeEl.hidden = false;

    initApp();

  } catch (err) {
    loadingEl.textContent = `❌ Krypto-Modul konnte nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`;
    loadingEl.className = "status error";
    console.error(err);
  }
}

main();
