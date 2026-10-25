import type { StateKey } from "./published-state-repository.js";

export type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; reason: string };
export interface SnapshotValidator<T> {
  schema(value: unknown): ValidationResult<T>;
  semantic(value: T): ValidationResult<T>;
}
export type ValidationStage = "json_parse" | "schema" | "semantic";
declare const evidenceBrand: unique symbol;
export interface ReadEvidence {
  readonly [evidenceBrand]: true;
}
export type ReadResult<T> =
  | { outcome: "latest"; generation: number; snapshot: T }
  | {
      outcome: "previous";
      generation: number;
      snapshot: T;
      latestInvalid: {
        generation: number;
        stage: ValidationStage;
        reason: string;
      };
      evidence: ReadEvidence;
    }
  | { outcome: "empty"; kind: "new" | "counter_only" }
  | { outcome: "isolated"; reason: string }
  | {
      outcome: "database_error";
      reason: string;
      layer: "L1" | "L2" | "L3" | "L4";
    }
  | {
      outcome: "validator_error";
      stage: "schema" | "semantic";
      reason: string;
    };
export type AdoptionDecision =
  { outcome: "newer" } | { outcome: "not_newer" } | { outcome: "unknown" };
export interface ConditionalSaveRequest {
  stateKey: StateKey;
  snapshotJson: string;
  evidence: ReadEvidence;
  adoption: AdoptionDecision;
}
type Checked<T> =
  | { kind: "valid"; value: T }
  | { kind: "invalid"; stage: ValidationStage; reason: string }
  | {
      kind: "error";
      stage: "schema" | "semantic";
      reason: string;
      exceptionType: string;
    };
function run<T>(
  stage: "schema" | "semantic",
  operation: () => ValidationResult<T>,
): Checked<T> {
  try {
    const result = operation();
    // A Promise or malformed validator return is a validator bug, not bad data.
    if (
      !result ||
      typeof result !== "object" ||
      (result.valid !== true && result.valid !== false) ||
      (result.valid === false && typeof result.reason !== "string") ||
      (result.valid === true && !("value" in result))
    )
      throw new TypeError();
    return result.valid
      ? { kind: "valid", value: result.value }
      : { kind: "invalid", stage, reason: result.reason };
  } catch (error) {
    const exceptionType =
      error instanceof TypeError
        ? "TypeError"
        : error instanceof RangeError
          ? "RangeError"
          : error instanceof Error
            ? "Error"
            : "NonError";
    return {
      kind: "error",
      stage,
      reason: "validator_threw_or_invalid_result",
      exceptionType,
    };
  }
}
/** Pure validation only. No DB operations, TTL decisions or Domain rules. */
export function checkSnapshot<T>(
  json: string,
  validator: SnapshotValidator<T>,
): Checked<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: "invalid", stage: "json_parse", reason: "invalid_json" };
  }
  const schema = run("schema", () => validator.schema(parsed));
  if (schema.kind !== "valid") return schema;
  return run("semantic", () => validator.semantic(schema.value));
}
