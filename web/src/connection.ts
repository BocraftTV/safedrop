/**
 * ConnectionManager — orchestrates Signaling + WebRTC.
 *
 * State machine:
 *   idle → signaling → waiting_peer (sender) / webrtc (receiver)
 *        → webrtc → connected → closed
 *
 * Usage:
 *   const mgr = new ConnectionManager();
 *   mgr.onStateChange = (s) => updateUI(s);
 *   mgr.onChannelOpen = (ch) => startTransfer(ch);
 *
 *   // Sender:
 *   await mgr.startAsSender(code => showCode(code));
 *
 *   // Receiver:
 *   await mgr.startAsReceiver(code);
 */

import { SignalingClient } from "./signaling.ts";

export type AppState =
  | "idle"
  | "signaling"       // connecting to signaling server
  | "waiting_peer"    // sender: code shown, waiting for receiver to join
  | "webrtc"          // SDP exchange / ICE gathering in progress
  | "connected"       // DataChannel open, ready to transfer
  | "closed"
  | "error";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/** Number of parallel DataChannels (SCTP streams) for chunk transfer. */
const CHANNEL_COUNT = 4;

export class ConnectionManager {
  private signaling = new SignalingClient();
  private pc: RTCPeerConnection | null = null;
  private _channels: RTCDataChannel[] = [];
  private _state: AppState = "idle";

  onStateChange: ((state: AppState, detail?: string) => void) | null = null;
  /** Called when all DataChannels are open and ready for binary data. */
  onChannelOpen: ((channels: RTCDataChannel[]) => void) | null = null;
  /** Called when the remote peer disconnects. */
  onPeerDisconnected: (() => void) | null = null;

  get state(): AppState { return this._state; }
  get channels(): RTCDataChannel[] { return this._channels; }

  // ── Sender ──────────────────────────────────────────────────────────────

  async startAsSender(onCode: (code: string) => void): Promise<void> {
    this.setState("signaling");

    const code = await this.signaling.connectAsSender();
    onCode(code);
    this.setState("waiting_peer");

    this.signaling.onPeerJoined = () => {
      this.setState("webrtc");
      this.runSender().catch((err) => this.fail(err));
    };

    this.signaling.onPeerDisconnected = () => {
      this.onPeerDisconnected?.();
    };
  }

  // ── Receiver ─────────────────────────────────────────────────────────────

  async startAsReceiver(code: string): Promise<void> {
    this.setState("signaling");
    await this.signaling.connectAsReceiver(code);
    this.setState("webrtc");
    await this.runReceiver();
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  disconnect(): void {
    this.signaling.disconnect();
    for (const ch of this._channels) ch.close();
    this.pc?.close();
    this.pc = null;
    this._channels = [];
    this.setState("closed");
  }

  // ── Private: WebRTC (Sender) ──────────────────────────────────────────────

  private async runSender(): Promise<void> {
    const pc = this.createPC();

    // Create multiple unordered DataChannels before offer (so they're included in the SDP).
    // ordered: false eliminates SCTP head-of-line blocking — chunks carry their own index
    // so the receiver can reassemble regardless of arrival order.
    const channels: RTCDataChannel[] = [];
    let openCount = 0;

    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const ch = pc.createDataChannel(`sd-${i}`, { ordered: false });
      ch.binaryType = "arraybuffer";
      channels.push(ch);

      ch.onopen = () => {
        if (++openCount === CHANNEL_COUNT) {
          this._channels = channels;
          this.setState("connected");
          this.onChannelOpen?.(channels);
        }
      };
      ch.onclose = () => {
        if (this._state === "connected") this.setState("closed");
      };
    }

    // Sender receives answer + ICE from receiver
    this.signaling.onAnswer = async (sdp) => {
      await pc.setRemoteDescription(sdp);
    };
    this.signaling.onIceCandidate = async (candidate) => {
      await pc.addIceCandidate(candidate).catch(console.warn);
    };

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendOffer(offer);
  }

  // ── Private: WebRTC (Receiver) ────────────────────────────────────────────

  private async runReceiver(): Promise<void> {
    const pc = this.createPC();

    // Collect DataChannels as they arrive from the sender
    const channels: RTCDataChannel[] = [];
    let openCount = 0;

    pc.ondatachannel = (event) => {
      const ch = event.channel;
      ch.binaryType = "arraybuffer";
      channels.push(ch);

      ch.onopen = () => {
        if (++openCount === CHANNEL_COUNT) {
          // Sort by label so sd-0 is first (control channel)
          channels.sort((a, b) => a.label.localeCompare(b.label));
          this._channels = channels;
          this.setState("connected");
          this.onChannelOpen?.(channels);
        }
      };
      ch.onclose = () => {
        if (this._state === "connected") this.setState("closed");
      };
    };

    // Receiver receives offer + ICE from sender
    this.signaling.onOffer = async (sdp) => {
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.sendAnswer(answer);
    };
    this.signaling.onIceCandidate = async (candidate) => {
      await pc.addIceCandidate(candidate).catch(console.warn);
    };
  }

  // ── Private: Helpers ──────────────────────────────────────────────────────

  private createPC(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;

    // Forward our ICE candidates to the peer via signaling
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.sendIceCandidate(e.candidate.toJSON());
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.fail(new Error("WebRTC connection failed — check firewall / NAT settings"));
      }
    };

    return pc;
  }

  private setState(s: AppState, detail?: string): void {
    this._state = s;
    this.onStateChange?.(s, detail);
  }

  private fail(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ConnectionManager]", msg);
    this.setState("error", msg);
  }
}
