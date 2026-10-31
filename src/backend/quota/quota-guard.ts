export const TOMORROW_IO = "tomorrow.io" as const;
export type QuotaProvider = typeof TOMORROW_IO;
export interface QuotaMetadata {
  providerKey: string;
  historyStatus: "ACTIVE" | "SUSPENDED";
  initializedAtMs: number;
  lastSequence: number;
}
export interface QuotaConsumption {
  sequence: number;
  reservedAtMs: number;
}
export interface QuotaHistory {
  metadata: QuotaMetadata | null;
  consumptions: readonly QuotaConsumption[];
}
/** Supplied by trusted Application/C-Impl-4 monitoring. Not inferred from DB. */
export interface QuotaTrust {
  clockTrusted: boolean;
  historyTimestampsTrusted: boolean;
  historyComplete: boolean;
}
export interface QuotaInspectionResult {
  allowed: boolean;
  reason: string;
  recheckAtMs?: number;
}
export const QUOTA_WINDOWS = Object.freeze([
  Object.freeze({ widthMs: 86400000, limit: 400 }),
  Object.freeze({ widthMs: 3600000, limit: 20 }),
  Object.freeze({ widthMs: 1000, limit: 1 }),
]);
export const QUOTA_MARGIN_MS = 2000; // Provisional design margin; not a measured guarantee.
export function quotaTimestamp(n: number): boolean {
  return (
    Number.isSafeInteger(n) && n >= 0 && Number.isFinite(new Date(n).getTime())
  );
}
export class QuotaGuard {
  evaluate(
    provider: string,
    history: QuotaHistory,
    now: number,
    trust: QuotaTrust,
  ): QuotaInspectionResult {
    const deny = (reason: string): QuotaInspectionResult => ({
      allowed: false,
      reason,
    });
    if (provider !== TOMORROW_IO) return deny("unsupported_provider");
    if (trust?.clockTrusted !== true) return deny("clock_untrusted");
    if (trust.historyTimestampsTrusted !== true)
      return deny("history_timestamps_untrusted");
    if (trust.historyComplete !== true) return deny("history_incomplete");
    if (!quotaTimestamp(now)) return deny("invalid_timestamp");
    const m = history.metadata;
    if (
      !m ||
      m.providerKey !== provider ||
      !["ACTIVE", "SUSPENDED"].includes(m.historyStatus) ||
      !quotaTimestamp(m.initializedAtMs) ||
      m.initializedAtMs > now ||
      !Number.isSafeInteger(m.lastSequence) ||
      m.lastSequence < 0
    )
      return deny("invalid_metadata");
    if (m.historyStatus !== "ACTIVE") return deny("provider_suspended");
    if (m.lastSequence !== history.consumptions.length)
      return deny("history_sequence_mismatch");
    let previous = m.initializedAtMs;
    for (let i = 0; i < history.consumptions.length; i++) {
      const c = history.consumptions[i];
      if (!Number.isSafeInteger(c.sequence) || c.sequence !== i + 1)
        return deny("history_sequence_mismatch");
      if (
        !quotaTimestamp(c.reservedAtMs) ||
        c.reservedAtMs < previous ||
        c.reservedAtMs > now
      )
        return deny("invalid_history_timestamp");
      previous = c.reservedAtMs;
    }
    if (m.lastSequence === Number.MAX_SAFE_INTEGER)
      return deny("sequence_exhausted");
    let recheckAtMs = 0;
    for (const w of QUOTA_WINDOWS) {
      const recent = history.consumptions.filter(
        (c) => now - c.reservedAtMs <= w.widthMs + QUOTA_MARGIN_MS,
      );
      if (recent.length >= w.limit) {
        // At the inclusive boundary it is still counted, so +1 epoch ms is the
        // earliest representable re-evaluation at which this slot can leave.
        const at =
          recent[recent.length - w.limit].reservedAtMs +
          w.widthMs +
          QUOTA_MARGIN_MS +
          1;
        if (!quotaTimestamp(at)) return deny("quota_boundary_out_of_range");
        recheckAtMs = Math.max(recheckAtMs, at);
      }
    }
    return recheckAtMs
      ? { allowed: false, reason: "quota_exhausted", recheckAtMs }
      : { allowed: true, reason: "quota_available" };
  }
}
