import {
  TOMORROW_IO,
  quotaTimestamp,
  type QuotaHistory,
  type QuotaConsumption,
  type QuotaProvider,
} from "./quota-guard.js";
import type { StartupResult } from "../storage/startup-transaction.js";
import type { QuotaReservationResult } from "../storage/quota-repository.js";

export interface HistoryScope {
  readonly providerKey: QuotaProvider;
  readonly generation: number;
  readonly processInstanceId: string;
  /** Persisted Startup cutoff; Runtime provisioning does not rewrite NULL. */
  readonly cutoffSequence: number | null;
}
export interface StartupBoundaryFacts extends HistoryScope {
  readonly startupOutcome: StartupResult["outcome"];
  readonly providerState: "UNPROVISIONED" | "PROVISIONED";
}
export interface RuntimeProvisioningFacts extends Omit<
  HistoryScope,
  "cutoffSequence"
> {
  readonly committed: boolean;
  readonly cutoffSequence: 0;
}
export interface RuntimeValidFacts extends HistoryScope {
  readonly sequence: number;
  readonly reservedAtMs: number;
  readonly reservationOutcome: QuotaReservationResult["outcome"];
  readonly clockTrustedAtReservation: boolean;
}
export interface ConfirmedRangeFacts extends HistoryScope {
  readonly committed: boolean;
  readonly rangeId: number;
  readonly startSequence: number;
  readonly endSequence: number;
}
/** Declarative facts only, NOT authenticated Runtime evidence or send authority.
 * 4B-2/3 must obtain/validate real Startup, Provisioning, Tx-Q, Clock and Range
 * evidence before supplying these facts. Matching strings/booleans is not that
 * validation. This module issues no evidence and has no production callers.
 */
export interface HistoryEvaluationFacts {
  readonly scope: HistoryScope;
  readonly boundary: StartupBoundaryFacts;
  readonly history: QuotaHistory;
  readonly historyComplete: boolean;
  readonly valid: readonly RuntimeValidFacts[];
  readonly ranges: readonly ConfirmedRangeFacts[];
  readonly runtimeProvisioning?: RuntimeProvisioningFacts;
}
export interface HistoryClassification {
  readonly old: readonly Readonly<QuotaConsumption>[];
  readonly newValid: readonly Readonly<QuotaConsumption>[];
  readonly newUncertain: readonly Readonly<{
    rangeId: number;
    consumptions: readonly Readonly<QuotaConsumption>[];
  }>[];
}
/** Classification-model assessment only. TRUSTED is not authenticated History
 * Trust, a Monitor confirmation, Quota Trust or permission to send.
 */
export type HistoryEvaluation =
  | { readonly evaluation: "BLOCKED"; readonly reason: string }
  | {
      readonly evaluation: "TRUSTED" | "CONSERVATIVE";
      readonly classification: HistoryClassification;
    };
const integer = (n: unknown): n is number =>
  typeof n === "number" &&
  Number.isSafeInteger(n) &&
  n >= 0 &&
  !Object.is(n, -0);
const timestamp = (n: unknown): n is number => integer(n) && quotaTimestamp(n);
const blocked = (reason: string): HistoryEvaluation =>
  Object.freeze({ evaluation: "BLOCKED", reason });
const sameScope = (a: HistoryScope, b: HistoryScope): boolean =>
  a.providerKey === b.providerKey &&
  a.generation === b.generation &&
  a.processInstanceId === b.processInstanceId &&
  a.cutoffSequence === b.cutoffSequence;

/** Pure classification-model assessment: even TRUSTED authenticates no Runtime
 * evidence or History Trust and grants no send permission.
 * Never call Monitor.confirm(), QuotaGuard or
 * Tx-Q here. CONSERVATIVE requires full counting of old/uncertain contributions
 * in every Window until independently verified wait evidence permits exclusion;
 * no waiting/exclusion/Quota/HTTP authorization is implemented by this function.
 */
export function evaluateHistoryFacts(
  facts: HistoryEvaluationFacts,
): HistoryEvaluation {
  try {
    const { scope, boundary, history, valid, ranges, runtimeProvisioning } =
      facts;
    if (
      scope.providerKey !== TOMORROW_IO ||
      !integer(scope.generation) ||
      scope.generation < 2 ||
      typeof scope.processInstanceId !== "string" ||
      scope.processInstanceId.length === 0 ||
      (scope.cutoffSequence !== null && !integer(scope.cutoffSequence))
    )
      return blocked("invalid_scope");
    if (!sameScope(scope, boundary) || boundary.startupOutcome !== "committed")
      return blocked("startup_unconfirmed");
    if (facts.historyComplete !== true) return blocked("history_incomplete");
    if (
      !Array.isArray(history.consumptions) ||
      !Array.isArray(valid) ||
      !Array.isArray(ranges)
    )
      return blocked("invalid_history");
    const metadata = history.metadata;
    let cutoff: number;
    if (boundary.providerState === "PROVISIONED") {
      if (
        !integer(boundary.cutoffSequence) ||
        runtimeProvisioning !== undefined
      )
        return blocked("invalid_cutoff");
      cutoff = boundary.cutoffSequence;
    } else if (boundary.providerState === "UNPROVISIONED") {
      // NULL is never coerced to zero. Only separately confirmed current-process
      // F-01 provisioning can supply the effective Runtime cutoff of zero.
      if (
        boundary.cutoffSequence !== null ||
        !runtimeProvisioning ||
        runtimeProvisioning.providerKey !== scope.providerKey ||
        runtimeProvisioning.generation !== scope.generation ||
        runtimeProvisioning.processInstanceId !== scope.processInstanceId ||
        runtimeProvisioning.committed !== true ||
        !integer(runtimeProvisioning.cutoffSequence) ||
        runtimeProvisioning.cutoffSequence !== 0
      )
        return blocked("runtime_provisioning_unconfirmed");
      cutoff = 0;
    } else return blocked("invalid_boundary");
    if (
      !metadata ||
      metadata.providerKey !== scope.providerKey ||
      (metadata.historyStatus !== "ACTIVE" &&
        metadata.historyStatus !== "SUSPENDED") ||
      !timestamp(metadata.initializedAtMs) ||
      !integer(metadata.lastSequence) ||
      metadata.lastSequence !== history.consumptions.length ||
      cutoff > metadata.lastSequence
    )
      return blocked("invalid_history");
    const rows = history.consumptions.map((row) => {
      if (!row || !integer(row.sequence) || !timestamp(row.reservedAtMs))
        throw new Error();
      return Object.freeze({
        sequence: row.sequence,
        reservedAtMs: row.reservedAtMs,
      });
    });
    if (rows.some((row, i) => row.sequence !== i + 1))
      return blocked("sequence_mismatch");
    let previousTimestamp = metadata.initializedAtMs;
    for (const row of rows) {
      if (row.reservedAtMs < previousTimestamp)
        return blocked("invalid_history_timestamp");
      previousTimestamp = row.reservedAtMs;
    }
    const validSequences = new Set<number>();
    for (const record of valid) {
      if (
        !sameScope(scope, record) ||
        record.reservationOutcome !== "saved" ||
        record.clockTrustedAtReservation !== true ||
        !integer(record.sequence) ||
        record.sequence <= cutoff ||
        record.sequence > rows.length ||
        validSequences.has(record.sequence) ||
        !timestamp(record.reservedAtMs) ||
        rows[record.sequence - 1].reservedAtMs !== record.reservedAtMs
      )
        return blocked("invalid_runtime_facts");
      validSequences.add(record.sequence);
    }
    const uncertain = new Set<number>();
    let previousRangeId = 0;
    let previousEnd = cutoff;
    const newUncertain: {
      rangeId: number;
      consumptions: Readonly<QuotaConsumption>[];
    }[] = [];
    // Require the confirmed append order; do not sort, merge or repair ranges.
    for (const range of ranges) {
      if (
        !sameScope(scope, range) ||
        range.committed !== true ||
        !integer(range.rangeId) ||
        range.rangeId <= previousRangeId ||
        !integer(range.startSequence) ||
        !integer(range.endSequence) ||
        range.startSequence <= previousEnd ||
        range.startSequence <= cutoff ||
        range.startSequence > range.endSequence ||
        range.endSequence > rows.length
      )
        return blocked("invalid_range");
      const part = {
        rangeId: range.rangeId,
        consumptions: [] as Readonly<QuotaConsumption>[],
      };
      for (
        let sequence = range.startSequence;
        sequence <= range.endSequence;
        sequence++
      ) {
        if (validSequences.has(sequence) || uncertain.has(sequence))
          return blocked("overlapping_classification");
        uncertain.add(sequence);
        part.consumptions.push(rows[sequence - 1]);
      }
      newUncertain.push(part);
      previousRangeId = range.rangeId;
      previousEnd = range.endSequence;
    }
    const old: Readonly<QuotaConsumption>[] = [];
    const newValid: Readonly<QuotaConsumption>[] = [];
    for (const row of rows) {
      if (row.sequence <= cutoff) old.push(row);
      else if (validSequences.has(row.sequence)) newValid.push(row);
      else if (!uncertain.has(row.sequence))
        return blocked("classification_gap");
    }
    const classification: HistoryClassification = Object.freeze({
      old: Object.freeze(old),
      newValid: Object.freeze(newValid),
      newUncertain: Object.freeze(
        newUncertain.map((part) =>
          Object.freeze({
            rangeId: part.rangeId,
            consumptions: Object.freeze(part.consumptions),
          }),
        ),
      ),
    });
    return Object.freeze({
      evaluation:
        old.length || newUncertain.length ? "CONSERVATIVE" : "TRUSTED",
      classification,
    });
  } catch {
    return blocked("invalid_facts");
  }
}
