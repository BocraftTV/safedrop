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
}

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
  private createdAt = 0;

  /** Timeout after which an incomplete room is cleaned up (5 minutes). */
  private static readonly ROOM_TIMEOUT_MS = 5 * 60 * 1000;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly state: any, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as "sender" | "receiver";
    const code = url.searchParams.get("code") ?? "";

    if (!this.code) {
      this.code = code;
      this.createdAt = Date.now();
    }

    // Reject if room is full
    if (role === "sender" && this.sender !== null) {
      return new Response("Room already has a sender", { status: 409 });
    }
    if (role === "receiver" && this.receiver !== null) {
      return new Response("Room already has a receiver", { status: 409 });
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
    } else {
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
      if (role === "sender") this.sender = null;
      else this.receiver = null;

      // Notify the other side
      peer()?.send(JSON.stringify({ type: "peer_disconnected" }));
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
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => CHARS[b % CHARS.length])
    .join("");
}
