/**
 * WebRTC types and helpers shared across the app.
 * The actual connection logic lives in connection.ts.
 */

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * Backpressure thresholds for the DataChannel send buffer.
 *
 * We keep sending as long as bufferedAmount < HIGH_WATER.
 * Once it hits HIGH_WATER we pause and wait until it drains to LOW_WATER.
 * The gap between the two prevents rapid on/off toggling.
 *
 * A large HIGH_WATER fills the bandwidth-delay product on high-latency links
 * (e.g. cross-network: 50 ms RTT × 100 Mbps ≈ 6 MB in flight needed).
 */
export const BUFFER_HIGH_WATER =  8 * 1024 * 1024; //  8 MiB — keep sending up to here (Chrome's hard queue limit is 16 MiB)
export const BUFFER_LOW_WATER  =  2 * 1024 * 1024; //  2 MiB — resume after draining to here

/**
 * Block until the DataChannel buffer has room (drops below LOW_WATER).
 * Call before each send; resolves immediately while buffer < HIGH_WATER.
 */
export function waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState !== "open") return Promise.reject(new Error("Verbindung unterbrochen"));
  if (channel.bufferedAmount < BUFFER_HIGH_WATER) return Promise.resolve();
  return new Promise((resolve, reject) => {
    channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    const cleanup = () => {
      channel.onbufferedamountlow = null;
      channel.removeEventListener("close", onClose);
    };
    const onClose = () => { cleanup(); reject(new Error("Verbindung unterbrochen")); };
    channel.addEventListener("close", onClose);
    channel.onbufferedamountlow = () => { cleanup(); resolve(); };
  });
}
