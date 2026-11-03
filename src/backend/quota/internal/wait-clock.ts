/** Platform assurance is intentionally unavailable until PR-C platform wiring.
 * A reading alone proves neither continuity nor an elapsed-real-time lower bound.
 * Tests replace this INTERNAL module with a Fake TimeSource and stable identity;
 * there is no production boolean/configuration escape hatch.
 */
export interface VerifiedWaitReading {
  readonly nowNs: bigint;
  readonly continuity: object;
}
export function verifiedWaitReading(): VerifiedWaitReading | null {
  return null;
}
