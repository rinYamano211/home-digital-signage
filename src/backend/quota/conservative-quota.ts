import {
  evaluateHistoryFacts,
  type HistoryEvaluationFacts,
} from "./history-evaluation.js";
import { quotaTimestamp } from "./quota-guard.js";
import { QUOTA_WINDOWS, quotaWindow } from "./internal/quota-window.js";
/** Per-window waits of the retired Plan D. Q-01 (Issue #117) no longer uses
 * them for Quota counting; only the internal Wait bookkeeping refers to them.
 */
export const HISTORY_WAIT_MS = Object.freeze({
  1000: 60000,
  3600000: 3900000,
  86400000: 90000000,
});
export type ConservativeQuotaResult =
  | { evaluation: "BLOCKED"; reason: string }
  | {
      evaluation: "WITHIN_LIMIT" | "QUOTA_BLOCKED";
      windows: readonly {
        widthMs: number;
        count: number;
        limit: number;
        releaseAtMs?: number;
      }[];
    };
/** Assessment only, never a send/QuotaTrust permission. Q-01 (Issue #117):
 * every Consumption (old, current-process Valid and confirmed uncertain
 * Ranges alike) is counted by its Timestamp with the symmetric Window. No
 * per-window wait is required, and Timestamp order or future values do not
 * block. Structural problems still fail closed through evaluateHistoryFacts.
 */
export function evaluateConservativeQuota(
  facts: HistoryEvaluationFacts,
  now: number,
): ConservativeQuotaResult {
  try {
    const model = evaluateHistoryFacts(facts);
    if (model.evaluation === "BLOCKED") return model;
    if (
      !quotaTimestamp(now) ||
      !facts.history.metadata ||
      facts.history.metadata.historyStatus !== "ACTIVE"
    )
      return { evaluation: "BLOCKED", reason: "invalid_quota_history" };
    const rows = [
      ...model.classification.old,
      ...model.classification.newValid,
      ...model.classification.newUncertain.flatMap((r) => r.consumptions),
    ];
    const windows = QUOTA_WINDOWS.map((w) => {
      const usage = quotaWindow(rows, now, w);
      return Object.freeze({
        widthMs: w.widthMs,
        count: usage.count,
        limit: w.limit,
        // A release beyond the valid Timestamp range gives no recheck hint;
        // the caller fails closed (quota_boundary_unavailable).
        ...(usage.releaseAtMs === undefined ||
        !quotaTimestamp(usage.releaseAtMs)
          ? {}
          : { releaseAtMs: usage.releaseAtMs }),
      });
    });
    return Object.freeze({
      evaluation: windows.some((w) => w.count >= w.limit)
        ? "QUOTA_BLOCKED"
        : "WITHIN_LIMIT",
      windows: Object.freeze(windows),
    });
  } catch {
    return { evaluation: "BLOCKED", reason: "invalid_quota_facts" };
  }
}
