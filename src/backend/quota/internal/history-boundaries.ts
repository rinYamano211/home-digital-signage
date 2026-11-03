import type { HistoryScope } from "../history-evaluation.js";
declare const drainBrand: unique symbol;
declare const waitBrand: unique symbol;
declare const provisioningBrand: unique symbol;
export interface DrainBoundaryEvidence {
  readonly [drainBrand]: true;
}
export interface WindowWaitEvidence {
  readonly [waitBrand]: true;
}
export interface RuntimeProvisioningEvidence {
  readonly [provisioningBrand]: true;
}
export interface DrainBoundary extends HistoryScope {
  readonly startSequence: number;
  readonly endSequence: number;
  readonly lastSequence: number;
}
export interface WindowWait extends HistoryScope {
  readonly rangeId: number | null;
  readonly endSequence: number;
  readonly windowMs: number;
  readonly elapsedNs: bigint;
}
/** Closed production ports. 4B-3 owns issuance/authentication/invalidation after
 * actual Drain / monotonic waiting / F-01. No issuer or boolean bypass exists in
 * 4B-2. Tests mock this INTERNAL boundary only; not a production factory option.
 */
export function inspectDrainEvidence(
  _proof: DrainBoundaryEvidence,
): DrainBoundary | null {
  void _proof; // No production authority exists until the 4B-3 issuer is implemented.
  return null;
}
export function inspectWaitEvidence(
  _proof: WindowWaitEvidence,
): WindowWait | null {
  void _proof; // No production authority exists until the 4B-3 issuer is implemented.
  return null;
}
export function inspectProvisioningEvidence(
  _proof: RuntimeProvisioningEvidence,
): HistoryScope | null {
  void _proof; // No production authority exists until the 4B-3 issuer is implemented.
  return null;
}
