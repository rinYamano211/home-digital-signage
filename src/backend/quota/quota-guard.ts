import {
  evaluateAuthenticatedQuota,
  type AuthenticatedHistorySource,
} from "./internal/history-boundaries.js";
import type { QuotaRepository } from "../storage/quota-repository.js";
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
export { QUOTA_WINDOWS, QUOTA_MARGIN_MS } from "./internal/quota-window.js";
import { QUOTA_WINDOWS, quotaWindow } from "./internal/quota-window.js";
export function quotaTimestamp(n: number): boolean {
  return (
    Number.isSafeInteger(n) && n >= 0 && Number.isFinite(new Date(n).getTime())
  );
}
export class QuotaGuard {
  /** Internal authenticated D-03 path. Uses the existing conservative evaluator;
   * no trust booleans are manufactured and the legacy evaluate stays unchanged.
   */
  evaluateAuthenticated(
    source: AuthenticatedHistorySource,
    repository: QuotaRepository,
    history: QuotaHistory,
    now: number,
  ): QuotaInspectionResult {
    return evaluateAuthenticatedQuota(source, repository, history, now);
  }
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
      const usage = quotaWindow(history.consumptions, now, w);
      if (usage.count >= w.limit) {
        const at = usage.releaseAtMs!;
        if (!quotaTimestamp(at)) return deny("quota_boundary_out_of_range");
        recheckAtMs = Math.max(recheckAtMs, at);
      }
    }
    return recheckAtMs
      ? { allowed: false, reason: "quota_exhausted", recheckAtMs }
      : { allowed: true, reason: "quota_available" };
  }
}
