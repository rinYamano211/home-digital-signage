/** MVP production Wait input (technology-stack PR-C completion plan, PR #75):
 * process.hrtime.bigint() (Linux CLOCK_MONOTONIC) with a per-process
 * continuity identity. Suspend is not counted, which only delays completion;
 * NTP frequency correction remains a residual risk for hardware validation.
 * A restarted Process gets a new identity, so no Wait survives a restart.
 * Backwards/invalid readings are expired by the History Recovery owner.
 */
export interface VerifiedWaitReading {
  readonly nowNs: bigint;
  readonly continuity: object;
}
const continuity = Object.freeze({});
export function verifiedWaitReading(): VerifiedWaitReading | null {
  try {
    const nowNs = process.hrtime.bigint();
    return typeof nowNs === "bigint" && nowNs >= 0n
      ? { nowNs, continuity }
      : null;
  } catch {
    return null;
  }
}
