import type { QuotaConsumption } from "../quota-guard.js";
export const QUOTA_WINDOWS = Object.freeze([
  Object.freeze({ widthMs: 86400000, limit: 400 }),
  Object.freeze({ widthMs: 3600000, limit: 20 }),
  Object.freeze({ widthMs: 1000, limit: 1 }),
]);
export const QUOTA_MARGIN_MS = 2000; // Provisional design margin; not a measured guarantee.
/** Shared inclusive Window math (technology-stack Q-01, Issue #117): a row
 * counts while |now - reservedAtMs| <= width + margin, so a future row counts
 * for at most about twice the reach. Caller validates the timestamps.
 * releaseAtMs is the earliest exit of enough counted rows, ordered by
 * Timestamp rather than Sequence. Rows entering later are ignored, so it is a
 * lower bound of the real release and never a send permission.
 */
export function quotaWindow(
  rows: readonly QuotaConsumption[],
  now: number,
  w: (typeof QUOTA_WINDOWS)[number],
): { count: number; releaseAtMs?: number } {
  const reachMs = w.widthMs + QUOTA_MARGIN_MS;
  const counted = rows
    .map((c) => c.reservedAtMs)
    .filter((t) => Math.abs(now - t) <= reachMs)
    .sort((a, b) => a - b);
  const count = counted.length;
  if (count < w.limit) return { count };
  return { count, releaseAtMs: counted[count - w.limit] + reachMs + 1 };
}
