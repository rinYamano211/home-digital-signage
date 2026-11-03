import type { QuotaConsumption } from "../quota-guard.js";
export const QUOTA_WINDOWS = Object.freeze([
  Object.freeze({ widthMs: 86400000, limit: 400 }),
  Object.freeze({ widthMs: 3600000, limit: 20 }),
  Object.freeze({ widthMs: 1000, limit: 1 }),
]);
export const QUOTA_MARGIN_MS = 2000; // Provisional design margin; not a measured guarantee.
/** Shared inclusive Window math; caller validates timestamps and ordering. */
export function quotaWindow(
  rows: readonly QuotaConsumption[],
  now: number,
  w: (typeof QUOTA_WINDOWS)[number],
  fullCount = 0,
): { count: number; releaseAtMs?: number } {
  const recent = rows.filter(
    (c) => now - c.reservedAtMs <= w.widthMs + QUOTA_MARGIN_MS,
  );
  const count = fullCount + recent.length;
  if (count < w.limit || fullCount >= w.limit) return { count };
  return {
    count,
    releaseAtMs:
      recent[recent.length - (w.limit - fullCount)].reservedAtMs +
      w.widthMs +
      QUOTA_MARGIN_MS +
      1,
  };
}
