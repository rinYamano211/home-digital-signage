/** Domain-independent OS / monotonic time boundary. */
export interface TimeSource {
  wallMs(): number;
  monotonicNs(): bigint;
}
export const systemTime: TimeSource = Object.freeze({
  wallMs: () => Date.now(),
  monotonicNs: () => process.hrtime.bigint(),
});
