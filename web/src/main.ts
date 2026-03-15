/**
 * SecureDrop — App Entry Point
 */

import { initCrypto, getCryptoModule } from "./crypto.ts";
import { initApp } from "./ui.ts";

async function main(): Promise<void> {
  const loadingEl = document.getElementById("wasm-loading") as HTMLDivElement;

  try {
    await initCrypto();

    const wasm = getCryptoModule();
    if (wasm.smokeTestAdd(1, 1) !== 2) throw new Error("WASM smoke test failed");

    // Hide loader, reveal both cards
    loadingEl.hidden = true;
    (document.getElementById("sender-view") as HTMLElement).hidden = false;
    (document.getElementById("receiver-view") as HTMLElement).hidden = false;

    initApp();

  } catch (err) {
    loadingEl.textContent = `❌ Krypto-Modul konnte nicht geladen werden: ${err instanceof Error ? err.message : String(err)}`;
    loadingEl.className = "status error";
    console.error(err);
  }
}

main();
