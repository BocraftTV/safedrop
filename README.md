# SecureDrop

> Zero-Knowledge, Browser-basiertes P2P File Sharing — Ende-zu-Ende verschlüsselt, kein Server sieht je Deine Daten.

**Status:** Phase 1 — Projekt-Setup ✅

---

## Was ist SecureDrop?

SecureDrop überträgt Dateien **direkt von Browser zu Browser** — ohne Server, ohne Account, ohne Installation. Der Kern der Kryptographie läuft als **WebAssembly-Modul** (kompiliert aus Rust) direkt im Browser:

- **X25519 ECDH** — ephemerer Schlüsselaustausch pro Transfer
- **HKDF-SHA256** — Key Derivation
- **ChaCha20-Poly1305** — AEAD-Verschlüsselung jedes Chunks
- **BLAKE3 + Merkle Tree** — Dateiintegrität

## Architektur

```
Browser A (Sender) ←——— WebRTC DataChannel (E2E verschlüsselt) ———→ Browser B (Empfänger)
         ↓                                                                    ↓
  WASM Krypto-Core                                                   WASM Krypto-Core
         ↓                                                                    ↓
         └——————— Cloudflare Worker (Signaling, SDP-Only) ———————————————┘
```

## Tech Stack

| Komponente | Technologie |
|---|---|
| Krypto-Core | Rust → WebAssembly (wasm-pack) |
| Frontend | TypeScript + Vite |
| Signaling | Cloudflare Worker (Durable Objects) |
| Hosting | GitHub Pages |
| CI/CD | GitHub Actions |

## Setup (Entwicklung)

### Voraussetzungen

- [Rust](https://rustup.rs/) (stable + `wasm32-unknown-unknown` target)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (für Signaling)

### Schritt 1: Rust installieren & WASM target hinzufügen

```bash
rustup target add wasm32-unknown-unknown
```

### Schritt 2: WASM-Modul bauen

```bash
wasm-pack build --target web --out-dir ../../web/src/wasm crates/crypto-core
```

Oder via npm script:

```bash
cd web && npm run wasm:build
```

### Schritt 3: Frontend starten

```bash
cd web
npm install
npm run dev
```

Öffne `http://localhost:5173` — die Seite zeigt den WASM Smoke Test.

### Rust Tests ausführen

```bash
cargo test --workspace
```

### Signaling Server lokal starten (Phase 3)

```bash
cd signaling
npm install -g wrangler
wrangler dev
```

## Projektstruktur

```
securedrop/
├── .github/workflows/deploy.yml    # CI: Test + WASM Build + GitHub Pages Deploy
├── crates/
│   └── crypto-core/                # Rust → WASM Krypto-Core
│       ├── src/
│       │   ├── lib.rs              # WASM Entry Point + Smoke Test Exports
│       │   ├── keys.rs             # X25519 Keypair + ECDH
│       │   ├── cipher.rs           # ChaCha20-Poly1305 Encrypt/Decrypt
│       │   ├── kdf.rs              # HKDF-SHA256 Key Derivation
│       │   ├── chunks.rs           # BLAKE3 + Merkle Tree + Chunking
│       │   └── utils.rs            # Panic Hook + Error Types
│       └── tests/                  # Rust Integration Tests
├── web/                            # TypeScript/Vite Frontend
│   ├── index.html
│   ├── src/
│   │   ├── main.ts                 # App Entry + Phase 1 Smoke Test
│   │   ├── crypto.ts               # WASM Bindings
│   │   ├── webrtc.ts               # RTCPeerConnection Wrapper
│   │   ├── signaling.ts            # Signaling Client
│   │   ├── transfer.ts             # File Transfer Protocol
│   │   ├── ui.ts                   # UI Logik
│   │   └── styles.css
│   └── src/wasm/                   # wasm-pack Output (generated, gitignored)
├── signaling/                      # Cloudflare Worker
│   ├── wrangler.toml
│   └── src/index.ts                # WebSocket Relay + Room Management
└── Cargo.toml                      # Workspace Root
```

## Implementierungsplan

| Phase | Status | Beschreibung |
|---|---|---|
| Phase 1 — Setup | ✅ | Monorepo, WASM Smoke Test, CI/CD |
| Phase 2 — Krypto-Core | 🔜 | X25519, ChaCha20, BLAKE3 vollständig |
| Phase 3 — Signaling | 🔜 | Cloudflare Worker, WebSocket Relay |
| Phase 4 — WebRTC | 🔜 | P2P DataChannel |
| Phase 5 — File Transfer | 🔜 | Verschlüsselter Dateitransfer |
| Phase 6 — UI | 🔜 | Sender/Empfänger UI, QR-Code |
| Phase 7 — Hardening | 🔜 | CSP, Rate Limiting, E2E Tests |

## Sicherheit

Jeder Transfer ist doppelt verschlüsselt:
1. **WebRTC DTLS** — Transport-Verschlüsselung
2. **ChaCha20-Poly1305** — Application-Level E2E (eigene Schicht)

Der Signaling-Server sieht **nur** Public Keys und SDP-Handshake — niemals Dateiinhalt oder Schlüssel.

## Lizenz

MIT
