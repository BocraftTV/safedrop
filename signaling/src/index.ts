/**
 * SecureDrop — Signaling Server (Cloudflare Worker + Durable Objects)
 *
 * Responsibilities:
 * - Accept WebSocket connections from browsers
 * - Create rooms (sender) / join rooms (receiver) identified by 6-char code
 * - Forward SDP offers, answers and ICE candidates between the two peers
 * - Delete rooms after transfer or after timeout
 *
 * What this server does NOT do:
 * - Store any file data
 * - Log IP addresses, user agents, or connection metadata
 * - Keep rooms alive beyond one transfer
 *
 * Full implementation in Phase 3.
 */

export interface Env {
  ROOMS: DurableObjectNamespace;
  /** Optional Cloudflare TURN key — enables TURN relay fallback when set (wrangler secret put). */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const STUN_ONLY: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

// ---------------------------------------------------------------------------
// Worker fetch handler — upgrades HTTP to WebSocket
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint for CI
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "securedrop-signaling" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // ICE server list (STUN, plus short-lived TURN credentials if configured)
    if (url.pathname === "/ice") {
      return new Response(JSON.stringify({ iceServers: await getIceServers(env) }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    }

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return handleWebSocket(request, env);
    }

    return new Response("SecureDrop Signaling Server. Connect via WebSocket.", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  },
};

async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    // New room — generate a code and create a Durable Object for it
    const newCode = generateCode();
    const id = env.ROOMS.idFromName(newCode);
    const stub = env.ROOMS.get(id);
    return stub.fetch(new Request(`https://internal/ws?code=${newCode}&role=sender`, request));
  } else {
    if (!/^[a-z0-9]{6}$/.test(code)) return rejectSocket("Ungültiger Code");
    // Join existing room
    const id = env.ROOMS.idFromName(code);
    const stub = env.ROOMS.get(id);
    return stub.fetch(new Request(`https://internal/ws?code=${code}&role=receiver`, request));
  }
}

// ---------------------------------------------------------------------------
// RoomManager — Durable Object that holds exactly two WebSocket connections
// ---------------------------------------------------------------------------

export class RoomManager {
  private sender: WebSocket | null = null;
  private receiver: WebSocket | null = null;
  private code = "";
  private timeout: ReturnType<typeof setTimeout> | null = null;

  /** Timeout after which a room nobody joined is closed (10 minutes). */
  private static readonly ROOM_TIMEOUT_MS = 10 * 60 * 1000;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly state: any, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as "sender" | "receiver";
    const code = url.searchParams.get("code") ?? "";

    if (!this.code) this.code = code;

    // Reject if room is full / does not exist. The WebSocket is accepted and
    // closed with an error message, because browsers can't read HTTP status
    // codes of a failed WebSocket upgrade.
    if (role === "sender" && this.sender !== null) {
      return rejectSocket("Code-Kollision — bitte erneut versuchen");
    }
    if (role === "receiver" && this.sender === null) {
      return rejectSocket("Code ungültig oder abgelaufen");
    }
    if (role === "receiver" && this.receiver !== null) {
      return rejectSocket("Für diesen Code ist bereits ein Empfänger verbunden");
    }

    // Upgrade to WebSocket
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    server.accept();

    if (role === "sender") {
      this.sender = server;
      this.setupSocket(server, "sender");
      // Notify sender of their room code
      server.send(JSON.stringify({ type: "room_created", code: this.code }));
      this.timeout = setTimeout(() => {
        if (this.receiver === null) this.sender?.close(4000, "Room expired");
      }, RoomManager.ROOM_TIMEOUT_MS);
    } else {
      if (this.timeout) clearTimeout(this.timeout);
      this.receiver = server;
      this.setupSocket(server, "receiver");
      // Notify sender that a receiver joined
      this.sender?.send(JSON.stringify({ type: "peer_joined" }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private setupSocket(ws: WebSocket, role: "sender" | "receiver"): void {
    const peer = (): WebSocket | null =>
      role === "sender" ? this.receiver : this.sender;

    ws.addEventListener("message", (event) => {
      // Forward all messages to the other peer verbatim
      // (SDP offers/answers and ICE candidates)
      const other = peer();
      if (other?.readyState === WebSocket.OPEN) {
        other.send(event.data as string);
      }
    });

    ws.addEventListener("close", () => {
      // Notify the other side
      const other = peer();
      if (other?.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ type: "peer_disconnected" }));
      }

      if (role === "sender") this.sender = null;
      else this.receiver = null;
    });

    ws.addEventListener("error", () => {
      if (role === "sender") this.sender = null;
      else this.receiver = null;
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a 6-character alphanumeric code.
 * Uses crypto.getRandomValues for unpredictability.
 * Character set: a-z + 0-9 (36^6 ≈ 2.2 billion combinations).
 */
function generateCode(): string {
  const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  while (code.length < 6) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      // Rejection sampling: 252 = 7 × 36, avoids modulo bias
      if (b < 252 && code.length < 6) code += CHARS[b % CHARS.length];
    }
  }
  return code;
}

/** Accept a WebSocket, send an error message and close it immediately. */
function rejectSocket(message: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();
  server.send(JSON.stringify({ type: "error", message }));
  server.close(4001, "rejected");
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Returns STUN servers plus short-lived Cloudflare TURN credentials if a TURN
 * key is configured. TURN relays the (already E2E-encrypted) data when a direct
 * P2P connection is impossible, e.g. mobile network ↔ WLAN behind strict NAT.
 */
async function getIceServers(env: Env): Promise<RTCIceServer[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN_ONLY;

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 3600 }),
      },
    );
    if (!res.ok) return STUN_ONLY;
    const data = (await res.json()) as { iceServers: RTCIceServer | RTCIceServer[] };
    const servers = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers];
    // Browsers time out on port 53 — drop those URLs
    return servers.map((s) => ({
      ...s,
      urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)),
    }));
  } catch {
    return STUN_ONLY;
  }
}
