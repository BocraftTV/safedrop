/**
 * Signaling Client — WebSocket connection to the Cloudflare Worker.
 *
 * The worker forwards all messages verbatim between the two peers.
 * Worker-generated messages: "room_created", "peer_joined"
 * Peer-generated (forwarded): "offer", "answer", "ice_candidate"
 */

export const SIGNALING_URL = "wss://securedrop-signaling.jakob-nuelle.workers.dev";

export type SignalingMessage =
  | { type: "room_created"; code: string }
  | { type: "peer_joined" }
  | { type: "peer_disconnected" }
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "ice_candidate"; candidate: RTCIceCandidateInit }
  | { type: "error"; message: string };

export class SignalingClient {
  private ws: WebSocket | null = null;

  // Callbacks — set by ConnectionManager before connecting
  onPeerJoined: (() => void) | null = null;
  onPeerDisconnected: (() => void) | null = null;
  onOffer: ((sdp: RTCSessionDescriptionInit) => void) | null = null;
  onAnswer: ((sdp: RTCSessionDescriptionInit) => void) | null = null;
  onIceCandidate: ((candidate: RTCIceCandidateInit) => void) | null = null;

  /**
   * Connect as sender (no code).
   * Worker generates a room code and sends back { type: "room_created", code }.
   * Resolves with the 6-char room code.
   */
  connectAsSender(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(SIGNALING_URL);

      this.ws.onerror = () => reject(new Error("Signaling: connection failed"));
      this.ws.onclose = (e) => {
        if (!e.wasClean) reject(new Error("Signaling: connection closed unexpectedly"));
      };

      this.ws.onmessage = (event) => {
        const msg = this.parse(event);
        if (!msg) return;

        if (msg.type === "room_created") {
          // Switch to ongoing message handler, then resolve
          this.ws!.onmessage = (e) => this.handleOngoing(e);
          resolve(msg.code);
        }
      };
    });
  }

  /**
   * Connect as receiver with a known room code.
   * Resolves once the WebSocket is open.
   */
  connectAsReceiver(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${SIGNALING_URL}?code=${code.toLowerCase().trim()}`);

      this.ws.onopen = () => {
        this.ws!.onmessage = (e) => this.handleOngoing(e);
        resolve();
      };
      this.ws.onerror = () => reject(new Error("Signaling: connection failed — is the code correct?"));
      this.ws.onclose = (e) => {
        if (!e.wasClean) reject(new Error("Signaling: connection closed unexpectedly"));
      };
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
    this.ws?.close(1000, "done");
    this.ws = null;
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
