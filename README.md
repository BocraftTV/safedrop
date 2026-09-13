# SafeDrop

> Zero-Knowledge, Browser-basiertes P2P File Sharing — Ende-zu-Ende verschlüsselt, kein Server kann Deine Daten lesen.

**🔒 Live:** [bocrafttv.github.io/safedrop](https://bocrafttv.github.io/safedrop/)

---

## Was ist SafeDrop?

SafeDrop überträgt Dateien **von Browser zu Browser**, ohne Account und ohne Installation. Die Daten gehen, wenn möglich, direkt zwischen den Geräten hin und her. Der Kern der Kryptographie läuft als **WebAssembly-Modul** (kompiliert aus Rust) im Browser des Nutzers.

### Workflow

1. Der Sender öffnet SafeDrop und wählt Dateien aus (Drag & Drop oder Klick).
2. Die App erzeugt einen einmaligen 6-stelligen Code und einen QR-Code.
3. Der Sender teilt den Code (Chat, SMS, mündlich) oder lässt den QR-Code scannen. Über den QR-Link verbindet sich der Empfänger automatisch.
4. Die WebRTC-Verbindung wird aufgebaut: direkt, oder über ein TURN-Relay, falls die Netzwerke keine Direktverbindung zulassen. Die App zeigt an, welcher Weg genutzt wird.
5. Beide Seiten sehen einen **Sicherheitscode** (4 Emoji) zur MITM-Verifikation.
6. Der Empfänger vergleicht die Emojis und nimmt an. **Erst dann** sendet der Sender Daten.
7. Der Empfänger speichert die Dateien per Download oder, auf dem Smartphone, über das Teilen-Menü.
8. Nach dem Transfer werden alle Schlüssel verworfen, es bleibt nichts zurück.

---

## Krypto-Protokoll

```
Sender                                              Empfänger
  │                                                      │
  │  1. X25519 Ephemeral Keypair                        │
  │     COMMIT: SHA-256(pk_s) ──────────────────────►   │
  │                                                      │
  │                    ◄──────────── PUBKEY: pk_r        │
  │                                  X25519 Keypair      │
  │                                                      │
  │     PUBKEY: pk_s ───────────────────────────────►   │
  │                              ✓ SHA-256(pk_s) == COMMIT
  │                                                      │
  │  2. ECDH → Shared Secret                            │
  │     HKDF-SHA256(secret, salt) → enc_key + nonce     │
  │     SAS = SHA-256(secret ‖ pk_s ‖ pk_r) → 4 Emoji   │
  │                                                      │
  │  3. HEADER (Salt, Dateiname, Größe, Chunk-Anzahl)   │
  │     ────────────────────────────────────────────►   │
  │                              Nutzer vergleicht Emoji │
  │                    ◄──────────── ACCEPT              │
  │                                                      │
  │  4. CHUNKs: ChaCha20-Poly1305(enc_key, nonce_i)     │
  │     ════════════════════════════════════════════►   │
  │                                                      │
  │  5. DONE: Merkle Root (BLAKE3-Hashes aller Chunks)  │
  │     ────────────────────────────────────────────►   │
  │                                ✓ Merkle Root verifiziert
  │                    ◄──────────── ACK                 │
  │                                                      │
  │  6. Alle Schlüssel werden verworfen                 │
```

Bricht eine Seite ab oder schlägt eine Prüfung fehl, geht eine `ERROR`-Nachricht an die Gegenseite, und beide brechen sofort ab.

### Sicherheitsebenen

| Ebene | Technologie | Schutz |
|---|---|---|
| Transport | WebRTC DTLS | Automatisch durch Browser |
| Application E2E | ChaCha20-Poly1305 | Eigene Verschlüsselungsschicht |
| Integrität | BLAKE3 + Merkle Tree | Manipulation pro Chunk erkennbar |
| Forward Secrecy | X25519 Ephemeral | Vergangene Transfers bleiben sicher |
| MITM-Verifikation | SAS (4 Emoji) + Hash-Commitment | Das Commitment verhindert, dass ein Angreifer passende Emojis durchprobiert. Ihm bleibt ein einziger Versuch (1 : 16 Mio.). |
| Zustimmung | ACCEPT-Nachricht | Vor der Bestätigung durch den Empfänger wird kein Byte übertragen |

### Welche Server sind beteiligt?

| Server | Wofür | Was er sieht |
|---|---|---|
| Signaling (Cloudflare Worker) | Vermittelt den Verbindungsaufbau über den 6-stelligen Code | Verbindungsmetadaten (SDP, ICE-Kandidaten). Keine Schlüssel, keine Dateien. Wird nach dem Verbinden geschlossen. |
| STUN | Hilft den Geräten, ihre öffentliche Adresse herauszufinden | Nur IP-Adressen |
| TURN (Cloudflare Realtime) | **Nur als Fallback**, wenn keine Direktverbindung möglich ist (z. B. Mobilfunk mit CGNAT, strenge Firewalls) | Leitet verschlüsselte Pakete weiter. Kann Datenmenge und Zeitpunkt sehen, aber keine Inhalte. |

---

## Tech Stack

| Komponente | Technologie |
|---|---|
| Krypto-Core | Rust → WebAssembly (wasm-pack) |
| Frontend | TypeScript + Vite |
| UI | Vanilla HTML/CSS |
| Signaling | Cloudflare Worker + Durable Objects |
| NAT-Traversal | STUN + Cloudflare TURN (Fallback) |
| Hosting | GitHub Pages |
| CI/CD | GitHub Actions |

---

## Lokale Entwicklung

### Voraussetzungen

- [Rust](https://rustup.rs/) (stable) mit WASM-Target: `rustup target add wasm32-unknown-unknown`
- wasm-pack: `cargo install wasm-pack --locked`
- [Node.js](https://nodejs.org/) 20+

### Setup

```bash
cd web
npm install

# WASM-Modul bauen (Ausgabe nach web/src/wasm, gitignored)
npm run wasm:build

# Frontend starten, nutzt den Live-Signaling-Server
npm run dev
```

Öffne `http://localhost:5173`

### Signaling-Server lokal

```bash
# Terminal 1
cd signaling
npx wrangler dev --port 8787

# Terminal 2
cd web
VITE_SIGNALING_URL=ws://localhost:8787 npm run dev
```

### Signaling-Server deployen

```bash
cd signaling
npx wrangler login
npx wrangler deploy
```

TURN ist optional. Ohne diese Secrets liefert der Worker nur STUN-Server. Zum Aktivieren im Cloudflare-Dashboard unter *Realtime → TURN* einen Key anlegen und dann:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Der Worker erzeugt daraus kurzlebige Zugangsdaten (1 h) über den Endpoint `/ice`. Das API-Token verlässt den Worker nie.

> Das Protokoll ändert sich gelegentlich inkompatibel. Nach einem Deploy sollten beide Geräte die Seite neu laden.

### Tests & Debugging

```bash
cargo test --workspace
```

- `?relay` an der URL erzwingt die Verbindung über TURN, praktisch zum Testen des Fallbacks. Es muss auf beiden Geräten gesetzt sein, und der Code muss manuell eingegeben werden, weil der QR-Link den Parameter nicht enthält.

---

## Projektstruktur

```
safedrop/
├── .github/workflows/deploy.yml    # CI: Rust Tests + WASM Build + Deploy (Frontend)
├── .claude/commands/handoff.md     # Claude-Code-Command für HANDOFF.md
├── HANDOFF.md                      # Übergabe-Notizen: Stand, Offenes, Entscheidungen
├── crates/
│   └── crypto-core/                # Rust → WASM Krypto-Core
│       ├── src/
│       │   ├── keys.rs             # X25519 Keypair + ECDH
│       │   ├── cipher.rs           # ChaCha20-Poly1305 Encrypt/Decrypt
│       │   ├── kdf.rs              # HKDF-SHA256 Key Derivation
│       │   ├── chunks.rs           # BLAKE3 + Merkle Tree
│       │   └── utils.rs            # Panic Hook
│       └── tests/                  # Rust Integration Tests
├── web/                            # TypeScript/Vite Frontend
│   ├── src/
│   │   ├── main.ts                 # App Entry Point
│   │   ├── crypto.ts               # WASM Bindings
│   │   ├── signaling.ts            # WebSocket-Client + ICE-Server-Abruf
│   │   ├── connection.ts           # WebRTC-Verbindungsaufbau + Routenerkennung
│   │   ├── webrtc.ts               # Backpressure-Helfer für DataChannels
│   │   ├── transfer.ts             # File Transfer Protocol
│   │   ├── ui.ts                   # UI Logic
│   │   └── styles.css
│   └── src/wasm/                   # wasm-pack Output (generated, gitignored)
├── signaling/                      # Cloudflare Worker (manuell deployt)
│   ├── src/index.ts                # WebSocket Relay, Räume, /ice (STUN/TURN)
│   └── wrangler.toml
└── Cargo.toml                      # Workspace Root
```

---

## Status

| Phase | Status | Beschreibung |
|---|---|---|
| Phase 1 — Setup | ✅ | Monorepo, WASM Smoke Test, CI/CD |
| Phase 2 — Krypto-Core | ✅ | X25519, ChaCha20-Poly1305, HKDF, BLAKE3/Merkle |
| Phase 3 — Signaling | ✅ | Cloudflare Worker, WebSocket Relay |
| Phase 4 — WebRTC | ✅ | P2P DataChannels, ICE/STUN |
| Phase 5 — File Transfer | ✅ | Binärprotokoll, Backpressure, Merkle-Verifikation |
| Phase 6 — UI | ✅ | QR-Code, SAS-Fingerprint, Bestätigung, ETA, Abbrechen, Teilen auf Mobilgeräten |
| Phase 7 — Hardening | 🚧 | ✅ TURN-Fallback, Hash-Commitment, Annahme vor Transfer · 🔜 Rate Limiting, E2E-Tests im Repo |

**Bekannte Grenze:** Der Empfänger hält empfangene Dateien im Arbeitsspeicher, bis sie gespeichert sind. Sehr große Dateien (mehrere GB) können vor allem auf iOS scheitern.

---

## Lizenz

MIT
