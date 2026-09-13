/**
 * Signaling Client — WebSocket connection to the Cloudflare Worker.
 *
 * The worker forwards all messages verbatim between the two peers.
 * Worker-generated messages: "room_created", "peer_joined", "peer_disconnected", "error"
 * Peer-generated (forwarded): "offer", "answer", "ice_candidate"
 */

export const SIGNALING_URL: string =
  import.meta.env.VITE_SIGNALING_URL ?? "wss://securedrop-signaling.jakob-nuelle.workers.dev";
const ICE_URL = SIGNALING_URL.replace(/^ws/, "http") + "/ice";

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

export type SignalingMessage =
  | { type: "room_created"; code: string }
  | { type: "peer_joined" }
  | { type: "peer_disconnected" }
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "ice_candidate"; candidate: RTCIceCandidateInit }
  | { type: "error"; message: string };

/**
 * Fetch ICE servers (STUN + TURN credentials, if the worker has TURN configured).
 * Falls back to public STUN servers if the request fails or takes too long.
 */
export async function fetchIceServers(timeoutMs = 2500): Promise<RTCIceServer[]> {
  try {
    const res = await fetch(ICE_URL, { signal: AbortSignal.timeout(timeoutMs) });
    const data = (await res.json()) as { iceServers?: RTCIceServer[] };
    if (Array.isArray(data.iceServers) && data.iceServers.length) return data.iceServers;
  } catch { /* fall through */ }
  return FALLBACK_ICE_SERVERS;
}

export class SignalingClient {
  private ws: WebSocket | null = null;

  // Callbacks — set by ConnectionManager before connecting
  onPeerJoined: (() => void) | null = null;
  onPeerDisconnected: (() => void) | null = null;
  onOffer: ((sdp: RTCSessionDescriptionInit) => void) | null = null;
  onAnswer: ((sdp: RTCSessionDescriptionInit) => void) | null = null;
  onIceCandidate: ((candidate: RTCIceCandidateInit) => void) | null = null;
  /** Server-side error (e.g. invalid code) or unexpected connection loss. */
  onError: ((message: string) => void) | null = null;

  /**
   * Connect as sender (no code).
   * Worker generates a room code and sends back { type: "room_created", code }.
   * Resolves with the 6-char room code.
   */
  connectAsSender(): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(SIGNALING_URL);
      this.ws = ws;
      let settled = false;

      ws.onerror = () => { if (!settled) { settled = true; reject(new Error("Signaling-Server nicht erreichbar")); } };
      ws.onclose = () => { if (!settled) { settled = true; reject(new Error("Signaling-Verbindung unerwartet geschlossen")); } };

      ws.onmessage = (event) => {
        const msg = this.parse(event);
        if (!msg) return;

        if (msg.type === "error" && !settled) {
          settled = true;
          reject(new Error(msg.message));
        } else if (msg.type === "room_created") {
          settled = true;
          this.attachOngoing(ws);
          resolve(msg.code);
        }
      };
    });
  }

  /**
   * Connect as receiver with a known room code.
   * Resolves once the WebSocket is open. An invalid code is reported
   * via onError (the server sends an error message and closes).
   */
  connectAsReceiver(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${SIGNALING_URL}?code=${encodeURIComponent(code.toLowerCase().trim())}`);
      this.ws = ws;
      let settled = false;

      ws.onopen = () => {
        settled = true;
        this.attachOngoing(ws);
        resolve();
      };
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error("Signaling-Server nicht erreichbar")); } };
      ws.onclose = () => { if (!settled) { settled = true; reject(new Error("Signaling-Verbindung unerwartet geschlossen")); } };
    });
  }

  sendOffer(sdp: RTCSessionDescriptionInit): void {
    this.send({ type: "offer", sdp });
  }

  sendAnswer(sdp: RTCSessionDescriptionInit): void {
    this.send({ type: "answer", sdp });
  }

  sendIceCandidate(candidate: RTCIceCandidateInit): void {
    this.send({ type: "ice_candidate", candidate });
  }

  disconnect(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close(1000, "done");
    }
  }

  private attachOngoing(ws: WebSocket): void {
    ws.onmessage = (e) => this.handleOngoing(e);
    ws.onerror = null;
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      // 4001 = rejected by server; the error message was already delivered
      if (e.code !== 1000 && e.code !== 4001) {
        this.onError?.(e.code === 4000 ? "Code abgelaufen" : "Verbindung zum Signaling-Server verloren");
      }
    };
  }

  private handleOngoing(event: MessageEvent): void {
    const msg = this.parse(event);
    if (!msg) return;

    switch (msg.type) {
      case "peer_joined":       this.onPeerJoined?.(); break;
      case "peer_disconnected": this.onPeerDisconnected?.(); break;
      case "offer":             this.onOffer?.(msg.sdp); break;
      case "answer":            this.onAnswer?.(msg.sdp); break;
      case "ice_candidate":     this.onIceCandidate?.(msg.candidate); break;
      case "error":             this.onError?.(msg.message); break;
    }
  }

  private parse(event: MessageEvent): SignalingMessage | null {
    try {
      return JSON.parse(event.data as string) as SignalingMessage;
    } catch {
      console.warn("Signaling: unparseable message", event.data);
      return null;
    }
  }

  private send(msg: object): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn("Signaling: tried to send while WS not open", msg);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }
}
