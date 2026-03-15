# SafeDrop

> Zero-Knowledge, Browser-basiertes P2P File Sharing — Ende-zu-Ende verschlüsselt, kein Server sieht je Deine Daten.

**🔒 Live:** [bocrafttv.github.io/safedrop](https://bocrafttv.github.io/safedrop/)

---

## Was ist SafeDrop?

SafeDrop überträgt Dateien **direkt von Browser zu Browser** — ohne Server, ohne Account, ohne Installation. Der Kern der Kryptographie läuft als **WebAssembly-Modul** (kompiliert aus Rust) direkt im Browser des Nutzers.

### Workflow

1. Sender öffnet SafeDrop, wählt Dateien per Drag & Drop
2. App generiert einen einmaligen 6-stelligen Code + QR-Code
3. Sender teilt den Code (Chat, SMS, mündlich)
4. Empfänger öffnet SafeDrop, gibt den Code ein
5. WebRTC-Verbindung wird direkt aufgebaut — kein Server in der Mitte
6. Beide Seiten sehen einen **Sicherheitscode** (4 Emoji) zur MITM-Verifikation
7. Empfänger bestätigt die Übertragung → verschlüsselter Transfer startet
8. Nach dem Transfer werden alle Schlüssel verworfen — nichts bleibt zurück

---

## Krypto-Protokoll

```
Sender                                              Empfänger
  │                                                      │
  │  1. X25519 Ephemeral Keypair                        │
  │     send pubkey ────────────────────────────────►   │
  │                                                      │
  │                    ◄──────────── send pubkey         │
  │                                  X25519 Keypair      │
  │                                                      │
  │  2. ECDH → Shared Secret                            │
  │     HKDF-SHA256(secret, salt) → enc_key + nonce     │
  │                                                      │
  │  3. Header senden (Dateiname, Größe, Chunk-Anzahl)  │
  │     ────────────────────────────────────────────►   │
  │                                                      │
  │  4. Chunks: ChaCha20-Poly1305(enc_key, nonce_i)     │
  │     ════════════════════════════════════════════►   │
  │                                                      │
  │  5. Merkle Root senden (BLAKE3-Hashes aller Chunks) │
  │     ────────────────────────────────────────────►   │
  │                                ✓ Merkle Root verifiziert
  │                    ◄──────────── ACK                 │
  │                                                      │
  │  6. Alle Schlüssel werden verworfen                 │
```

### Sicherheitsebenen

| Ebene | Technologie | Schutz |
|---|---|---|
| Transport | WebRTC DTLS | Automatisch durch Browser |
| Application E2E | ChaCha20-Poly1305 | Eigene Verschlüsselungsschicht |
| Integrität | BLAKE3 + Merkle Tree | Manipulation pro Chunk erkennbar |
| Forward Secrecy | X25519 Ephemeral | Vergangene Transfers bleiben sicher |
| MITM-Verifikation | SAS (4 Emoji) | Nutzer können Sicherheitscode vergleichen |

---

## Tech Stack

| Komponente | Technologie |
|---|---|
| Krypto-Core | Rust → WebAssembly (wasm-pack) |
| Frontend | TypeScript + Vite |
| UI | Vanilla HTML/CSS |
| Signaling | Cloudflare Worker + Durable Objects |
| Hosting | GitHub Pages |
| CI/CD | GitHub Actions |

---

## Lokale Entwicklung

### Voraussetzungen

- [Rust](https://rustup.rs/) (stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- [Node.js](https://nodejs.org/) 18+

### Setup

```bash
# 1. WASM-Modul bauen
cd web && npm run wasm:build

# 2. Frontend starten
npm install
npm run dev
```

Öffne `http://localhost:5173`

### Rust Tests

```bash
cargo test --workspace
```

---

## Projektstruktur

```
safedrop/
├── .github/workflows/deploy.yml    # CI: Rust Tests + WASM Build + Deploy
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
│   │   ├── connection.ts           # WebRTC + Signaling Orchestration
│   │   ├── transfer.ts             # File Transfer Protocol
│   │   ├── ui.ts                   # UI Logic
│   │   └── styles.css
│   └── src/wasm/                   # wasm-pack Output (generated, gitignored)
├── signaling/                      # Cloudflare Worker
│   └── src/index.ts                # WebSocket Relay + Room Management
└── Cargo.toml                      # Workspace Root
```

---

## Status

| Phase | Status | Beschreibung |
|---|---|---|
| Phase 1 — Setup | ✅ | Monorepo, WASM Smoke Test, CI/CD |
| Phase 2 — Krypto-Core | ✅ | X25519, ChaCha20-Poly1305, HKDF, BLAKE3/Merkle |
| Phase 3 — Signaling | ✅ | Cloudflare Worker, WebSocket Relay |
| Phase 4 — WebRTC | ✅ | P2P DataChannel, ICE/STUN |
| Phase 5 — File Transfer | ✅ | Binärprotokoll, Backpressure, Merkle-Verifikation |
| Phase 6 — UI | ✅ | QR-Code, SAS-Fingerprint, Bestätigung, ETA, Abbrechen |
| Phase 7 — Hardening | 🔜 | Rate Limiting, TURN Fallback, E2E Tests |

---

## Lizenz

MIT
