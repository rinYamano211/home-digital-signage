import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { createLogger } from "../logging/logger.js";
import {
  checkSnapshot,
  type SnapshotValidator,
  type ReadResult,
  type ReadEvidence,
  type ConditionalSaveRequest,
} from "./published-state-read.js";
export type {
  SnapshotValidator,
  ValidationResult,
  ValidationStage,
  ReadResult,
  ReadEvidence,
  ConditionalSaveRequest,
  AdoptionDecision,
} from "./published-state-read.js";
import { classifyDatabaseError, SchemaError } from "./errors.js";
import { validateSchema } from "./schema.js";

export const STATE_KEYS = Object.freeze([
  "currentWeather",
  "hourlyWeather",
  "rainForecast",
  "weeklyWeather",
  "schedule",
] as const);
export type StateKey = (typeof STATE_KEYS)[number];
type Scope = "input" | "state" | "database";
export interface SaveFailure {
  scope: Scope;
  reason: string;
  layer?: "L1" | "L2" | "L3" | "L4";
}
export type SaveResult =
  | {
      outcome: "saved";
      generation: number;
      snapshotJson: string;
      reconciled: boolean;
    }
  | ({ outcome: "not_saved" } & SaveFailure)
  | { outcome: "unknown"; scope: "state" | "database"; reason: string };
interface Snapshot {
  generation: number;
  json: string;
}
interface StateImage {
  counter: number | null;
  snapshots: Snapshot[];
}
interface Attempt {
  before: StateImage;
  expected: StateImage;
  generation: number;
  snapshotJson: string;
  failure?: SaveFailure;
}
interface EvidenceRecord {
  coordination: Coordination;
  connection: Database.Database;
  stateKey: StateKey;
  image: StateImage;
  source: "previous";
  consumed: boolean;
}
interface Coordination {
  busy: boolean;
  connectionUnresolved: boolean;
  blocked?: SaveFailure;
  pending: Map<StateKey, Attempt>;
}
// One gate per Connection, including when multiple Repository consumers wrap it.
const coordinators = new WeakMap<Database.Database, Coordination>();
// Module-private: no record or registry is exposed through Repository properties.
const readEvidenceRecords = new WeakMap<ReadEvidence, EvidenceRecord>();
class StateIntegrityError extends Error {
  constructor(readonly reason: string) {
    super("State counter integrity failure");
  }
}
class StaleEvidenceError extends Error {}
const maximum = BigInt(Number.MAX_SAFE_INTEGER);
function integer(value: unknown, minimum: bigint): number {
  // safeIntegers(true) preserves SQLite INTEGER before any JS number conversion.
  if (typeof value !== "bigint" || value < minimum || value > maximum)
    throw new StateIntegrityError("integer_out_of_range");
  return Number(value);
}
function same(a: StateImage, b: StateImage) {
  return (
    a.counter === b.counter &&
    a.snapshots.length === b.snapshots.length &&
    a.snapshots.every(
      (row, i) =>
        row.generation === b.snapshots[i].generation &&
        row.json === b.snapshots[i].json,
    )
  );
}
function failure(error: unknown): SaveFailure {
  if (error instanceof StaleEvidenceError)
    return { scope: "state", reason: "stale_read_evidence" };
  if (error instanceof StateIntegrityError)
    return { scope: "state", reason: error.reason, layer: "L3" };
  const code = (error as { code?: string })?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"))
    return { scope: "state", reason: "write_constraint", layer: "L3" };
  try {
    const status = classifyDatabaseError(error);
    return { scope: "database", reason: status.reason, layer: status.layer };
  } catch {
    return { scope: "database", reason: "storage_failure", layer: "L4" };
  }
}
function key(value: string): value is StateKey {
  return (STATE_KEYS as readonly string[]).includes(value);
}

/** Borrowed Connection only: BackendStore remains its sole owner/closer.
 * Application must validate Schema/Semantics/adoption before save. The Repository
 * only checks the key and serialized candidate syntax, outside Tx-P. Existing
 * snapshot content is validated only by read() with Application-owned validators.
 */
export class PublishedStateRepository {
  private readonly coordination: Coordination;
  constructor(
    private readonly db: Database.Database,
    private readonly logger: Pick<Logger, "warn" | "error"> = createLogger(),
  ) {
    let coordination = coordinators.get(db);
    if (!coordination) {
      coordination = {
        busy: false,
        connectionUnresolved: false,
        pending: new Map(),
      };
      coordinators.set(db, coordination);
    }
    this.coordination = coordination;
  }
  save(stateKey: string, snapshotJson: string): SaveResult {
    return this.saveTransaction(stateKey, snapshotJson);
  }
  saveConditionally(request: ConditionalSaveRequest): SaveResult {
    const record = readEvidenceRecords.get(request.evidence);
    if (
      !record ||
      record.source !== "previous" ||
      record.connection !== this.db ||
      record.coordination !== this.coordination ||
      record.stateKey !== request.stateKey ||
      !this.db.open
    )
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "invalid_read_evidence",
      };
    if (record.consumed)
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "consumed_read_evidence",
      };
    if (request.adoption?.outcome !== "newer")
      return {
        outcome: "not_saved",
        scope: "state",
        reason: "adoption_not_newer",
      };
    // Every attempted conditional Tx-P consumes its token, including failures.
    record.consumed = true;
    return this.saveTransaction(
      request.stateKey,
      request.snapshotJson,
      record.image,
    );
  }
  private saveTransaction(
    stateKey: string,
    snapshotJson: string,
    evidenceImage?: StateImage,
  ): SaveResult {
    if (!key(stateKey))
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "unsupported_state",
      };
    try {
      if (typeof snapshotJson !== "string") throw new Error();
      JSON.parse(snapshotJson);
    } catch {
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "invalid_candidate_json",
      };
    }
    const refusal = this.refusal(stateKey);
    if (refusal) return refusal;
    // All DB work below is synchronous, with no callbacks/await between steps.
    // JS run-to-completion serializes saves; the gate also refuses reentrant calls.
    this.coordination.busy = true;
    let attempt: Attempt | undefined;
    try {
      if (!this.transactionResolved()) return this.unresolvedConnection();
      this.db.exec("BEGIN IMMEDIATE");
      validateSchema(this.db);
      let before: StateImage;
      try {
        before = this.readImage(stateKey);
      } catch (error) {
        if (evidenceImage && error instanceof StateIntegrityError)
          throw new StaleEvidenceError();
        throw error;
      }
      if (evidenceImage && !same(before, evidenceImage))
        throw new StaleEvidenceError();
      const previous = before.counter ?? 0;
      if (previous === Number.MAX_SAFE_INTEGER)
        throw new StateIntegrityError("generation_exhausted");
      const generation = previous + 1;
      const expected: StateImage = {
        counter: generation,
        snapshots: [
          { generation, json: snapshotJson },
          ...before.snapshots,
        ].slice(0, 2),
      };
      attempt = { before, expected, generation, snapshotJson };
      this.coordination.pending.set(stateKey, attempt);
      this.db
        .prepare(
          "INSERT INTO state_generation_counters (state_key,last_generation) VALUES (?,?) ON CONFLICT(state_key) DO UPDATE SET last_generation=excluded.last_generation",
        )
        .run(stateKey, generation);
      this.db
        .prepare(
          "INSERT INTO published_state_snapshots (state_key,generation,snapshot_json) VALUES (?,?,?)",
        )
        .run(stateKey, generation, snapshotJson);
      this.db
        .prepare(
          "DELETE FROM published_state_snapshots WHERE state_key=? AND generation NOT IN (SELECT generation FROM published_state_snapshots WHERE state_key=? ORDER BY generation DESC LIMIT 2)",
        )
        .run(stateKey, stateKey);
      this.db.exec("COMMIT");
      if (!this.transactionResolved()) return this.unresolvedConnection();
      this.coordination.pending.delete(stateKey);
      return { outcome: "saved", generation, snapshotJson, reconciled: false };
    } catch (error) {
      const problem = failure(error);
      if (attempt) attempt.failure = problem;
      if (!this.rollback()) return this.unresolvedConnection();
      const result = attempt
        ? this.compare(stateKey, attempt, problem)
        : { outcome: "not_saved" as const, ...problem };
      if (
        result.outcome !== "saved" &&
        problem.scope === "database" &&
        (problem.layer === "L3" || problem.layer === "L4")
      )
        this.coordination.blocked = problem;
      return result;
    } finally {
      this.coordination.busy = false;
    }
  }
  read<T>(stateKey: string, validator: SnapshotValidator<T>): ReadResult<T> {
    if (!key(stateKey))
      return { outcome: "isolated", reason: "unsupported_state" };
    if (this.coordination.connectionUnresolved) return this.unresolvedRead();
    if (this.coordination.busy)
      return {
        outcome: "database_error",
        layer: "L1",
        reason: "connection_busy",
      };
    if (this.coordination.blocked)
      return this.readFailure(this.coordination.blocked);
    if (this.coordination.pending.has(stateKey))
      return { outcome: "isolated", reason: "unresolved_save" };
    // Keep the shared gate through validation to reject Validator DB reentry.
    // The actual SQLite Read Transaction ends BEFORE any Validator is called.
    this.coordination.busy = true;
    try {
      let image: StateImage;
      try {
        if (!this.transactionResolved()) return this.unresolvedRead();
        this.db.exec("BEGIN");
        validateSchema(this.db);
        image = this.readImage(stateKey);
        this.db.exec("COMMIT");
        if (!this.transactionResolved()) return this.unresolvedRead();
      } catch (error) {
        if (!this.finishFailedReadTransaction()) return this.unresolvedRead();
        return this.readFailure(failure(error));
      }
      const [latest, previous] = image.snapshots;
      if (!latest)
        return {
          outcome: "empty",
          kind: image.counter === null ? "new" : "counter_only",
        };
      const latestCheck = checkSnapshot(latest.json, validator);
      this.logValidation(stateKey, latest.generation, latestCheck);
      if (latestCheck.kind === "error")
        return {
          outcome: "validator_error",
          stage: latestCheck.stage,
          reason: latestCheck.reason,
        };
      if (latestCheck.kind === "valid")
        return {
          outcome: "latest",
          generation: latest.generation,
          snapshot: latestCheck.value,
        };
      if (!previous)
        return { outcome: "isolated", reason: "no_valid_snapshot" };
      const previousCheck = checkSnapshot(previous.json, validator);
      this.logValidation(stateKey, previous.generation, previousCheck);
      if (previousCheck.kind === "error")
        return {
          outcome: "validator_error",
          stage: previousCheck.stage,
          reason: previousCheck.reason,
        };
      if (previousCheck.kind === "invalid")
        return { outcome: "isolated", reason: "no_valid_snapshot" };
      try {
        if (!this.db.open || !this.transactionResolved())
          return this.unresolvedRead();
      } catch {
        return this.unresolvedRead();
      }
      const evidence = Object.freeze(Object.create(null)) as ReadEvidence;
      readEvidenceRecords.set(evidence, {
        coordination: this.coordination,
        connection: this.db,
        stateKey,
        image,
        source: "previous",
        consumed: false,
      });
      return {
        outcome: "previous",
        generation: previous.generation,
        snapshot: previousCheck.value,
        latestInvalid: {
          generation: latest.generation,
          stage: latestCheck.stage,
          reason: latestCheck.reason,
        },
        evidence,
      };
    } finally {
      this.coordination.busy = false;
    }
  }
  private finishFailedReadTransaction(): boolean {
    try {
      const active = this.db.inTransaction;
      if (active === false) return true; // COMMIT may have completed before throwing.
      if (active !== true) return false;
    } catch {
      return false;
    } // Never guess or issue ROLLBACK on an unknown status.
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // ROLLBACK itself may have completed before its exception notification.
      // Only an observable final state can resolve this read-only Transaction.
    }
    try {
      return this.transactionResolved();
    } catch {
      return false;
    }
  }
  private unresolvedRead(): ReadResult<never> {
    this.unresolvedConnection();
    return {
      outcome: "database_error",
      layer: "L4",
      reason: "transaction_unresolved",
    };
  }
  private readFailure(problem: SaveFailure): ReadResult<never> {
    if (problem.scope === "state")
      return { outcome: "isolated", reason: problem.reason };
    if (problem.layer === "L3" || problem.layer === "L4")
      this.coordination.blocked = problem;
    return {
      outcome: "database_error",
      layer: problem.layer ?? "L4",
      reason: problem.reason,
    };
  }
  private logValidation(
    stateKey: StateKey,
    generation: number,
    result: ReturnType<typeof checkSnapshot>,
  ) {
    if (result.kind === "valid") return;
    try {
      // No raw exception messages, Validator reasons or Snapshot contents in logs.
      if (result.kind === "error")
        this.logger.error(
          {
            event: "snapshot_validator_error",
            stateKey,
            generation,
            stage: result.stage,
            exceptionType: result.exceptionType,
          },
          "Snapshot Validator failed",
        );
      else
        this.logger.warn(
          {
            event: "snapshot_validation_failed",
            stateKey,
            generation,
            stage: result.stage,
          },
          "Snapshot validation failed",
        );
    } catch {
      /* Logging failure must not change validation/fallback decisions. */
    }
  }
  /** Explicit read-only reconciliation; never re-executes Tx-P or retries a write.
   * Pending evidence is Process-local, not a durable operation identity.
   */
  reconcile(stateKey: string): SaveResult {
    if (!key(stateKey))
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "unsupported_state",
      };
    if (this.coordination.connectionUnresolved)
      return this.unresolvedConnection();
    if (this.coordination.busy)
      return {
        outcome: "unknown",
        scope: "database",
        reason: "connection_busy",
      };
    const attempt = this.coordination.pending.get(stateKey);
    if (!attempt)
      return {
        outcome: "not_saved",
        scope: "state",
        reason: "no_pending_attempt",
      };
    this.coordination.busy = true;
    try {
      return this.compare(
        stateKey,
        attempt,
        attempt.failure ?? {
          scope: "database",
          reason: "write_not_saved",
        },
      );
    } finally {
      this.coordination.busy = false;
    }
  }
  private refusal(stateKey: StateKey): SaveResult | undefined {
    if (this.coordination.connectionUnresolved)
      return this.unresolvedConnection();
    if (this.coordination.pending.has(stateKey))
      return { outcome: "unknown", scope: "state", reason: "unresolved_save" };
    if (this.coordination.busy)
      return {
        outcome: "not_saved",
        scope: "database",
        reason: "connection_busy",
      };
    if (this.coordination.blocked)
      return { outcome: "not_saved", ...this.coordination.blocked };
  }
  private transactionResolved() {
    return this.db.inTransaction === false;
  }
  private unresolvedConnection(): SaveResult {
    // No ordinary DB operations resume on this Connection; Lifecycle/Recovery
    // must re-establish a safe Connection outside this implementation scope.
    this.coordination.connectionUnresolved = true;
    return {
      outcome: "unknown",
      scope: "database",
      reason: "transaction_unresolved",
    };
  }
  private rollback() {
    try {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      return this.transactionResolved();
    } catch {
      return false;
    }
  }
  private readImage(stateKey: StateKey): StateImage {
    const row = this.db
      .prepare(
        "SELECT last_generation FROM state_generation_counters WHERE state_key=?",
      )
      .safeIntegers(true)
      .get(stateKey) as { last_generation: unknown } | undefined;
    const raw = this.db
      .prepare(
        "SELECT generation,snapshot_json FROM published_state_snapshots WHERE state_key=? ORDER BY generation DESC",
      )
      .safeIntegers(true)
      .all(stateKey) as { generation: unknown; snapshot_json: unknown }[];
    const counter = row ? integer(row.last_generation, 0n) : null;
    const snapshots = raw.map((row) => {
      if (typeof row.snapshot_json !== "string")
        throw new StateIntegrityError("invalid_snapshot_storage");
      return {
        generation: integer(row.generation, 1n),
        json: row.snapshot_json,
      };
    });
    if (
      snapshots.length &&
      (counter === null || counter < snapshots[0].generation)
    )
      throw new StateIntegrityError("counter_inconsistent");
    return { counter, snapshots };
  }
  private compare(
    stateKey: StateKey,
    attempt: Attempt,
    problem: SaveFailure,
  ): SaveResult {
    try {
      if (!this.transactionResolved()) return this.unresolvedConnection();
      validateSchema(this.db);
      const actual = this.readImage(stateKey);
      if (!this.transactionResolved()) return this.unresolvedConnection();
      if (same(actual, attempt.expected)) {
        this.coordination.pending.delete(stateKey);
        return {
          outcome: "saved",
          generation: attempt.generation,
          snapshotJson: attempt.snapshotJson,
          reconciled: true,
        };
      }
      if (same(actual, attempt.before)) {
        this.coordination.pending.delete(stateKey);
        return { outcome: "not_saved", ...problem };
      }
      return {
        outcome: "unknown",
        scope: "state",
        reason: "unexpected_saved_state",
      };
    } catch (error) {
      const problem = failure(error);
      if (
        problem.scope === "database" &&
        (error instanceof SchemaError ||
          problem.layer === "L3" ||
          problem.layer === "L4")
      )
        this.coordination.blocked = problem;
      // A failed transaction-state observation blocks even other States.
      try {
        if (!this.transactionResolved()) return this.unresolvedConnection();
      } catch {
        return this.unresolvedConnection();
      }
      return {
        outcome: "unknown",
        scope: problem.scope === "state" ? "state" : "database",
        reason: "reconciliation_failed",
      };
    }
  }
}
