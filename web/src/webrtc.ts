/**
 * WebRTC types and helpers shared across the app.
 * The actual connection logic lives in connection.ts.
 */

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/** Maximum DataChannel buffer before we pause sending (backpressure). */
export const BUFFER_HIGH_WATER = 16 * 1024 * 1024; // 16 MiB
export const BUFFER_LOW_WATER  = 1 * 1024 * 1024;  // 1 MiB

/**
 * Wait until the DataChannel's bufferedAmount drops below the low-water mark.
 * Call before sending each chunk to avoid overwhelming the buffer.
 */
export function waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState !== "open") return Promise.reject(new Error("Verbindung unterbrochen"));
  if (channel.bufferedAmount <= BUFFER_LOW_WATER) return Promise.resolve();
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
