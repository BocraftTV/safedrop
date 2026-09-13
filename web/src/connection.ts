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

import { SignalingClient, fetchIceServers } from "./signaling.ts";

export type AppState =
  | "idle"
  | "signaling"       // connecting to signaling server
  | "waiting_peer"    // sender: code shown, waiting for receiver to join
  | "webrtc"          // SDP exchange / ICE gathering in progress
  | "connected"       // DataChannel open, ready to transfer
  | "closed"
  | "error";

/** Number of parallel DataChannels (SCTP streams). Channel 0 carries control messages. */
const CHANNEL_COUNT = 4;

/** Give up if the P2P connection isn't established within this time. */
const CONNECT_TIMEOUT_MS = 30_000;

/** How the data flows: directly between the devices or relayed through the TURN server. */
export type ConnectionRoute = "direct" | "relay";

/** Debug: `?relay` in the URL forces TURN (iceTransportPolicy "relay"). */
const FORCE_RELAY = new URLSearchParams(window.location.search).has("relay");

export class ConnectionManager {
  private signaling = new SignalingClient();
  private pc: RTCPeerConnection | null = null;
  private _channels: RTCDataChannel[] = [];
  private _state: AppState = "idle";
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Signaling messages are processed strictly in order (offer before ICE candidates). */
  private sigChain: Promise<void> = Promise.resolve();

  onStateChange: ((state: AppState, detail?: string) => void) | null = null;
  /** Called when all DataChannels are open and ready for binary data. */
  onChannelOpen: ((channels: RTCDataChannel[]) => void) | null = null;
  /** Called when the P2P connection to the peer is lost after it was established. */
  onPeerDisconnected: (() => void) | null = null;
  /** Called once connected and whenever the route changes (e.g. direct → relay). */
  onRouteChange: ((route: ConnectionRoute) => void) | null = null;

  private route: ConnectionRoute | null = null;
  private routeTimer: ReturnType<typeof setInterval> | null = null;

  get state(): AppState { return this._state; }
  get channels(): RTCDataChannel[] { return this._channels; }

  /** Inspect the active ICE candidate pair: is a TURN relay involved? */
  async getRoute(): Promise<ConnectionRoute | null> {
    const pc = this.pc;
    if (!pc) return null;
    const stats = await pc.getStats();

    let pair: RTCIceCandidatePairStats | undefined;
    stats.forEach((s) => {
      // Chrome/Safari: transport.selectedCandidatePairId
      if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) {
      // Fallback (Firefox / older Safari): the nominated, succeeded pair
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && (s.selected || (s.nominated && s.state === "succeeded"))) pair ??= s;
      });
    }
    if (!pair) return null;

    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "direct";
  }

  // ── Sender ──────────────────────────────────────────────────────────────

  async startAsSender(onCode: (code: string) => void): Promise<void> {
    this.setState("signaling");
    const iceServers = fetchIceServers();

    this.signaling.onError = (msg) => this.fail(new Error(msg));
    this.signaling.onPeerDisconnected = () => {
      if (this._state !== "connected") this.fail(new Error("Empfänger hat die Verbindung getrennt"));
    };
    this.signaling.onPeerJoined = () => {
      this.setState("webrtc");
      this.startConnectTimer();
      iceServers.then((servers) => this.runSender(servers)).catch((err) => this.fail(err));
    };

    const code = await this.signaling.connectAsSender();
    onCode(code);
    this.setState("waiting_peer");
  }

  // ── Receiver ─────────────────────────────────────────────────────────────

  async startAsReceiver(code: string): Promise<void> {
    this.setState("signaling");
    const iceServers = fetchIceServers();

    // Register handlers before connecting — the offer may arrive right after the socket opens.
    // Messages are queued on sigChain until the PeerConnection exists.
    const pcReady = iceServers.then((servers) => this.runReceiver(servers));
    this.signaling.onOffer = (sdp) => this.enqueue(async () => {
      const pc = await pcReady;
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signaling.sendAnswer(answer);
    });
    this.signaling.onIceCandidate = (candidate) => this.enqueue(async () => {
      const pc = await pcReady;
      await pc.addIceCandidate(candidate).catch((e) => console.warn("addIceCandidate", e));
    });
    this.signaling.onError = (msg) => this.fail(new Error(msg));
    this.signaling.onPeerDisconnected = () => {
      if (this._state !== "connected") this.fail(new Error("Sender hat die Verbindung getrennt"));
    };

    await this.signaling.connectAsReceiver(code);
    if (this._state === "signaling") {
      this.setState("webrtc");
      this.startConnectTimer();
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  disconnect(): void {
    this.clearConnectTimer();
    this.stopRouteMonitor();
    this.signaling.disconnect();
    for (const ch of this._channels) ch.close();
    this.pc?.close();
    this.pc = null;
    this._channels = [];
    this.setState("closed");
  }

  // ── Private: WebRTC (Sender) ──────────────────────────────────────────────

  private async runSender(iceServers: RTCIceServer[]): Promise<void> {
    if (this._state !== "webrtc") return; // cancelled meanwhile
    const pc = this.createPC(iceServers);

    // Channel 0 (control) is ordered so the handshake arrives in sequence.
    // Data channels are unordered — this eliminates SCTP head-of-line blocking;
    // chunks carry their own index so the receiver reassembles them.
    const channels: RTCDataChannel[] = [];
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const ch = pc.createDataChannel(`sd-${i}`, { ordered: i === 0 });
      channels.push(ch);
    }
    this.trackChannels(channels);

    // Sender receives answer + ICE from receiver
    this.signaling.onAnswer = (sdp) => this.enqueue(() => pc.setRemoteDescription(sdp));
    this.signaling.onIceCandidate = (candidate) => this.enqueue(async () => {
      await pc.addIceCandidate(candidate).catch((e) => console.warn("addIceCandidate", e));
    });

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signaling.sendOffer(offer);
  }

  // ── Private: WebRTC (Receiver) ────────────────────────────────────────────

  private runReceiver(iceServers: RTCIceServer[]): RTCPeerConnection {
    const pc = this.createPC(iceServers);

    const channels: RTCDataChannel[] = [];
    pc.ondatachannel = (event) => {
      channels.push(event.channel);
      if (channels.length === CHANNEL_COUNT) {
        // Sort by label so sd-0 (control channel) is first
        channels.sort((a, b) => a.label.localeCompare(b.label));
        this.trackChannels(channels);
      }
    };

    return pc;
  }

  // ── Private: Helpers ──────────────────────────────────────────────────────

  private createPC(iceServers: RTCIceServer[]): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: FORCE_RELAY ? "relay" : "all" });
    this.pc = pc;

    // Forward our ICE candidates to the peer via signaling
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.sendIceCandidate(e.candidate.toJSON());
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
      if (this._state === "connected" && (s === "failed" || s === "closed")) {
        this.onPeerDisconnected?.();
      } else if (s === "failed") {
        this.fail(new Error("P2P-Verbindung fehlgeschlagen — die Netzwerke erlauben keine Direktverbindung"));
      }
    };

    return pc;
  }

  /** Wait until all channels are open, then hand them to the app. */
  private trackChannels(channels: RTCDataChannel[]): void {
    let openCount = 0;
    const onOpen = () => {
      if (++openCount !== CHANNEL_COUNT) return;
      this.clearConnectTimer();
      this._channels = channels;
      // Signaling is no longer needed — close it so the room code can't be reused
      this.signaling.disconnect();
      this.setState("connected");
      this.onChannelOpen?.(channels);
      this.startRouteMonitor();
    };

    for (const ch of channels) {
      ch.binaryType = "arraybuffer";
      if (ch.readyState === "open") onOpen();
      else ch.addEventListener("open", onOpen, { once: true });
      ch.addEventListener("close", () => {
        if (this._state === "connected") {
          this.setState("closed");
          this.onPeerDisconnected?.();
        }
      });
    }
  }

  private startRouteMonitor(): void {
    this.stopRouteMonitor();
    const check = () => {
      this.getRoute().then((route) => {
        if (route && route !== this.route && this._state === "connected") {
          this.route = route;
          this.onRouteChange?.(route);
        }
      }).catch(() => { /* stats unavailable — ignore */ });
    };
    check();
    this.routeTimer = setInterval(check, 5000);
  }

  private stopRouteMonitor(): void {
    if (this.routeTimer) clearInterval(this.routeTimer);
    this.routeTimer = null;
    this.route = null;
  }

  private enqueue(task: () => Promise<void>): void {
    this.sigChain = this.sigChain.then(task).catch((err) => this.fail(err));
  }

  private startConnectTimer(): void {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.fail(new Error("Zeitüberschreitung beim Verbindungsaufbau — sind beide Geräte online?"));
    }, CONNECT_TIMEOUT_MS);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private setState(s: AppState, detail?: string): void {
    this._state = s;
    this.onStateChange?.(s, detail);
  }

  private fail(err: unknown): void {
    if (this._state === "error" || this._state === "closed") return;
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ConnectionManager]", msg);
    this.clearConnectTimer();
    this.stopRouteMonitor();
    this.signaling.disconnect();
    this.pc?.close();
    this.pc = null;
    this.setState("error", msg);
  }
}
