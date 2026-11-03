import {
  evaluateHistoryFacts,
  type HistoryEvaluationFacts,
} from "./history-evaluation.js";
import { quotaTimestamp } from "./quota-guard.js";
import { QUOTA_WINDOWS, quotaWindow } from "./internal/quota-window.js";
import {
  inspectWaitEvidence,
  type WindowWaitEvidence,
} from "./internal/history-boundaries.js";
export const HISTORY_WAIT_MS = Object.freeze({
  1000: 60000,
  3600000: 3900000,
  86400000: 90000000,
});
export type ConservativeQuotaResult =
  | { evaluation: "BLOCKED"; reason: string }
  | {
      evaluation: "WITHIN_LIMIT" | "QUOTA_BLOCKED";
      windows: readonly { widthMs: number; count: number; limit: number }[];
    };
/** Assessment only, never a send/QuotaTrust permission. Missing, forged or
 * expired Wait evidence always retains full contributions.
 */
export function evaluateConservativeQuota(
  facts: HistoryEvaluationFacts,
  now: number,
  waits: readonly WindowWaitEvidence[] = [],
): ConservativeQuotaResult {
  try {
    const model = evaluateHistoryFacts(facts);
    if (model.evaluation === "BLOCKED") return model;
    if (
      !quotaTimestamp(now) ||
      !facts.history.metadata ||
      facts.history.metadata.historyStatus !== "ACTIVE" ||
      model.classification.newValid.some((r) => r.reservedAtMs > now) ||
      !Array.isArray(waits)
    )
      return { evaluation: "BLOCKED", reason: "invalid_quota_history" };
    const completed = (
      rangeId: number | null,
      endSequence: number,
      widthMs: number,
    ): boolean =>
      waits.some((token) => {
        const p = inspectWaitEvidence(token);
        const s = facts.scope;
        return (
          !!p &&
          p.providerKey === s.providerKey &&
          p.generation === s.generation &&
          p.processInstanceId === s.processInstanceId &&
          p.cutoffSequence === s.cutoffSequence &&
          p.rangeId === rangeId &&
          p.endSequence === endSequence &&
          p.windowMs === widthMs &&
          typeof p.elapsedNs === "bigint" &&
          p.elapsedNs >=
            BigInt(HISTORY_WAIT_MS[widthMs as keyof typeof HISTORY_WAIT_MS]) *
              1000000n
        );
      });
    const windows = QUOTA_WINDOWS.map((w) => {
      let full = completed(
        null,
        model.classification.old.at(-1)?.sequence ?? 0,
        w.widthMs,
      )
        ? 0
        : model.classification.old.length;
      for (const range of model.classification.newUncertain)
        if (
          !completed(
            range.rangeId,
            range.consumptions.at(-1)!.sequence,
            w.widthMs,
          )
        )
          full += range.consumptions.length;
      return Object.freeze({
        widthMs: w.widthMs,
        count: quotaWindow(model.classification.newValid, now, w, full).count,
        limit: w.limit,
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
