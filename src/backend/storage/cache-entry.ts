import { utcInstant } from "../time/utc-instant.js";
export { utcInstant } from "../time/utc-instant.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { StateKey, SaveFailure } from "./published-state-repository.js";
import type { ValidationStage } from "./published-state-read.js";
export interface CacheEntry<T> {
  schemaVersion: 1;
  data: T;
  dataUpdatedAt: string;
  expiresAt: string;
}
declare const cacheEvidenceBrand: unique symbol;
export interface CacheReadEvidence {
  readonly [cacheEvidenceBrand]: true;
}
export type CacheReadResult<T> =
  | { outcome: "found"; entry: CacheEntry<T>; evidence: CacheReadEvidence }
  | {
      outcome: "invalid";
      stage: ValidationStage;
      reason: string;
      evidence: CacheReadEvidence;
    }
  | { outcome: "empty"; evidence: CacheReadEvidence }
  | { outcome: "validator_error"; stage: "schema" | "semantic"; reason: string }
  | {
      outcome: "database_error";
      layer: "L1" | "L2" | "L3" | "L4";
      reason: string;
    }
  | { outcome: "pending"; reason: "commit_result_unknown" };
export type CacheAdoptionDecision =
  { outcome: "adopt" } | { outcome: "reject" } | { outcome: "unknown" };
export interface CacheConditionalSaveRequest<T> {
  stateKey: StateKey;
  entry: CacheEntry<T>;
  evidence: CacheReadEvidence;
  adoption: CacheAdoptionDecision;
}
export type CacheSaveResult =
  | { outcome: "saved"; reconciled: boolean }
  | { outcome: "unchanged" }
  | ({ outcome: "not_saved" } & SaveFailure)
  | { outcome: "unknown"; scope: "state" | "database"; reason: string };
const entrySchema = Type.Object({
  schemaVersion: Type.Literal(1),
  data: Type.Unknown(),
  dataUpdatedAt: Type.String(),
  expiresAt: Type.String(),
});
export function isCacheEntry(value: unknown): value is CacheEntry<unknown> {
  return (
    Value.Check(entrySchema, value) &&
    Object.hasOwn(value as object, "data") &&
    utcInstant((value as CacheEntry<unknown>).dataUpdatedAt) !== null &&
    utcInstant((value as CacheEntry<unknown>).expiresAt) !== null
  );
}
export type CacheUseResult<T> =
  | { outcome: "usable"; entry: CacheEntry<T> }
  | { outcome: "expired" }
  | { outcome: "time_unknown" }
  | { outcome: "invalid" }
  | { outcome: "unavailable"; reason: string };
/** Caller supplies trusted epoch milliseconds; null means time is not trusted.
 * Only usable carries data. No TTL extension, publication or physical deletion.
 */
export function evaluateCacheRead<T>(
  result: CacheReadResult<T>,
  now: number | null,
): CacheUseResult<T> {
  if (result.outcome === "invalid") return { outcome: "invalid" };
  if (result.outcome !== "found")
    return { outcome: "unavailable", reason: result.outcome };
  if (!isCacheEntry(result.entry)) return { outcome: "invalid" };
  if (
    now === null ||
    !Number.isFinite(now) ||
    !Number.isFinite(new Date(now).getTime())
  )
    return { outcome: "time_unknown" };
  return now < utcInstant(result.entry.expiresAt)!
    ? { outcome: "usable", entry: result.entry }
    : { outcome: "expired" };
}
