# HANDOFF

## Worum es geht

SafeDrop ist eine browserbasierte P2P-Dateiübertragung mit Ende-zu-Ende-Verschlüsselung. Die Kryptografie läuft in Rust, kompiliert zu WebAssembly: X25519, ChaCha20-Poly1305 und ein BLAKE3-Merkle-Baum. Das Frontend ist TypeScript mit Vite und wird auf GitHub Pages gehostet. Den Verbindungsaufbau vermittelt ein Cloudflare Worker mit Durable Objects (`signaling/`), die Daten laufen danach über WebRTC-DataChannels.

## Stand

- Rust: `cargo test --workspace` läuft durch, 43 Tests bestanden.
- WASM: `wasm-pack build --target web --release --out-dir ../../web/src/wasm crates/crypto-core` baut ohne Fehler.
- Frontend: `npm run build` in `web/` (tsc + Vite) läuft ohne Fehler.
- Signaling-Worker ist deployed (Version `5f2e60ec-847d-4bec-8a56-7514d8133474`). Live gegen `wss://securedrop-signaling.jakob-nuelle.workers.dev` geprüft:
  - Falscher Code: nach ca. 230 ms `{"type":"error","message":"Code ungültig oder abgelaufen"}`, Close-Code 4001.
  - `/ice` liefert Cloudflare-TURN-Zugangsdaten. Die Secrets `TURN_KEY_ID` und `TURN_KEY_API_TOKEN` sind gesetzt.
- E2E-Test mit headless Chrome (puppeteer-core) und Vite-Dev gegen den Live-Worker: alle 12 Checks bestanden. Geprüft wurden:
  - falscher Code wird abgelehnt
  - Emoji-Code (SAS) auf beiden Seiten gleich
  - vor „Annehmen“ wird kein Byte gesendet
  - 20 MiB, eine kleine und eine leere Datei kommen hash-identisch an
  - Ablehnen und Abbrechen werden der Gegenseite angezeigt
  - QR-Link verbindet automatisch
  - Code ist nach dem Verbinden nicht wiederverwendbar
- Routenanzeige gegen Cloudflare-TURN getestet: normal „⚡ Direktverbindung“ (20 MiB, 4,9 MiB/s), mit `?relay` „🔁 Über TURN-Relay“ (2,8 MiB/s). Hash jeweils OK.
- Durchsatz lokal (headless Chrome, localhost, 100 MiB): alter und neuer Stand gleich, ca. 12 MiB/s.
- **Unsicher:** Auf einem echten iPhone ist noch nichts getestet. Die neuen Frontend-Änderungen sind noch nicht auf GitHub Pages (nur committet, nicht gepusht).

## Zuletzt gemacht (2026-09-13)

- Repo auf neuem Mac eingerichtet: `rustup target add wasm32-unknown-unknown`, `cargo install wasm-pack --locked` (0.15.0), `npm ci` in `web/`. Node v24.18.0 über fnm.
- Anlass waren Fehler beim Test Mac → iPhone über GitHub Pages: langer Verbindungsaufbau, Übertragung startete vor der Emoji-Bestätigung, am iPhone keine Download-Möglichkeit.
- Protokoll (`web/src/transfer.ts`):
  - Neue Nachrichten `COMMIT` (0x07) und `ACCEPT` (0x08). Der Sender wartet mit dem Senden, bis der Empfänger annimmt.
  - Schlüsselaustausch mit Hash-Commitment; der SAS wird aus Shared Secret und beiden Public Keys berechnet.
  - `ERROR` von der Gegenseite und geschlossene Channels brechen wartende Schritte sofort ab.
  - Der Header wird validiert.
  - Empfänger setzt Dateien schrittweise zusammen (`FileAssembler`, Flush alle 32 MiB).
- Verbindung (`web/src/connection.ts`):
  - ICE-Server kommen vom Worker (`/ice`), Fallback STUN.
  - Signaling-Nachrichten werden strikt nacheinander verarbeitet.
  - 30 s Connect-Timeout.
  - Control-Channel `sd-0` ist ordered, die übrigen 3 Channels unordered.
  - Signaling wird nach dem Verbinden geschlossen.
  - Routenerkennung über `getStats()`, alle 5 s neu geprüft.
  - `?relay` erzwingt TURN.
- Signaling-Client (`web/src/signaling.ts`): Server-Fehler werden weitergegeben, `VITE_SIGNALING_URL` überschreibt die Server-URL.
- Worker (`signaling/src/index.ts`):
  - Empfänger ohne existierenden Sender wird abgelehnt.
  - Räume ohne Beitritt verfallen nach 10 min.
  - Endpoint `/ice` mit Cloudflare-TURN.
  - Code-Erzeugung ohne Modulo-Bias.
- UI (`web/src/ui.ts`, `web/index.html`, `web/src/styles.css`):
  - Status für jeden Schritt; Abbrechen-Button auch beim Warten auf den Empfänger.
  - Auto-Connect über `?code=`.
  - Teilen-Button (Web Share API) neben dem Download.
  - `beforeunload`-Warnung, Screen Wake Lock.
  - Routenanzeige direkt/TURN.
  - CSP erlaubt `img-src data:` (Favicon) und `ws://localhost:8787` / `http://localhost:8787` für lokales Signaling.
- Aufgeräumt: doppelte `ICE_SERVERS` in `web/src/webrtc.ts` entfernt.

## Offen

1. Pushen, danach Mac → iPhone auf GitHub Pages erneut testen, einmal im selben WLAN und einmal iPhone im Mobilfunk. Prüfen:
   - Kommt der Download- bzw. Teilen-Button?
   - Was zeigt die Routenanzeige?
   - Bei Fehlern Dateigröße und Fehlermeldung notieren.
2. Große Dateien auf iOS testen (mehrere hundert MB bis GB). Der Empfänger hält alles als Blob im Speicher. Ob Safari das auslagert, ist unklar.
3. E2E-Tests ins Repo übernehmen. Sie liegen bisher nur in einem temporären Scratchpad und sind nicht versioniert.
4. `wrangler` als devDependency ins Repo (z. B. `signaling/package.json`); bisher gibt es dort keine `package.json`. Optional Worker-Deploy in CI.
5. README aktualisieren:
   - „kein Server sieht je Deine Daten“: mit TURN laufen verschlüsselte Daten ggf. über Cloudflare.
   - Protokollbeschreibung (COMMIT/ACCEPT).
   - Phase 7 teilweise erledigt (TURN).
6. `npm audit` meldet 4 Schwachstellen (1 moderate, 3 high) in `postcss`, das über Vite reinkommt. Nur Dev-Umgebung, `npm audit fix` noch nicht ausgeführt.
7. Optional: `Cargo.lock` committen (steht in `.gitignore`), damit WASM-Builds reproduzierbar sind.

## Entscheidungen

- **Annahme im Protokoll statt nur in der UI:** Früher hat nur die UI gewartet, der Sender schickte trotzdem alles und der Empfänger pufferte es. Das machte den Emoji-Vergleich wirkungslos und kostete RAM auf dem iPhone.
- **Hash-Commitment vor dem Schlüsselaustausch:** Ohne Commitment kann ein Angreifer mit Kontrolle über das Signaling einen passenden 24-Bit-SAS in Sekunden durchprobieren. Mit Commitment bleibt ihm ein einziger Versuch (1:2^24).
- **Fehlerhafte Codes: WebSocket annehmen, `error` senden, schließen.** Browser können den HTTP-Status eines fehlgeschlagenen WebSocket-Upgrades nicht auslesen, ein 404/409 würde nur als generischer Fehler ankommen.
- **TURN über Cloudflare Realtime**, Zugangsdaten kurzlebig (TTL 3600 s) über `/ice` erzeugt. Keine statischen Zugangsdaten im Frontend.
- **Frontend fällt auf STUN zurück**, wenn `/ice` nicht antwortet (2,5 s Timeout). So bleibt der alte Worker kompatibel.
- **Control-Channel ordered, Daten-Channels unordered:** Der Handshake muss in Reihenfolge ankommen. Die Chunks tragen ihren Index, und unordered vermeidet Head-of-Line-Blocking (siehe Commit 7d9147b).
- **Signaling nach dem Verbinden schließen**, damit der Code nicht erneut benutzt werden kann. Nachteil: kein ICE-Restart über Signaling möglich.
- **Verworfen: Streaming auf die Festplatte am iPhone.** Die File System Access API gibt es auf iOS nicht; ein Service-Worker-Download (StreamSaver-Ansatz) ist auf iOS unzuverlässig. Stattdessen Blob plus Web Share API.
- **Verworfen: TURN-Key per API anlegen.** Das OAuth-Token von `wrangler login` hat keinen Scope für Realtime/Calls, der Key musste im Dashboard angelegt werden.

## Fallstricke

- Beim Einrichten fehlten `wasm-pack` und das Target `wasm32-unknown-unknown`, obwohl Rust installiert war.
- npm 11.16 blockiert Install-Scripts. Der Build funktioniert trotzdem, es kommt aber diese Warnung:
  `npm warn allow-scripts 2 packages have install scripts not yet covered by allowScripts: esbuild@0.21.5, fsevents@2.3.3`
- Der alte Worker nahm jeden Code an. Mit falschem Code öffnete der WebSocket sich und hing ewig, ohne Fehler.
- `wrangler deploy` ohne Login: `You are not authenticated. Please run \`wrangler login\`.`
- Die CSP in `web/index.html` blockiert `ws://localhost` und `fetch()` auf Blob-URLs:
  - Lokales Signaling brauchte einen CSP-Eintrag.
  - E2E-Tests, die Blobs lesen, brauchen `page.setBypassCSP(true)`. Die Fehlermeldung war: `Fetch API cannot load blob:http://localhost:5173/... Refused to connect because it violates the document's Content Security Policy.`
- Protokoll inkompatibel zur alten Version: Beide Geräte müssen nach dem Deploy neu laden. Sonst wartet eine Seite vergeblich, bis „Keine Antwort vom anderen Gerät — bitte beide Seiten neu laden …“ erscheint.
- `?relay` wird beim Beitritt über den QR-Link nicht übernommen, weil der Link nur `?code=` enthält. Für TURN-Tests den Code manuell auf einer `?relay`-Seite eingeben.
