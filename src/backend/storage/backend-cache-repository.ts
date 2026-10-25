import type Database from "better-sqlite3";
import type { Logger } from "pino";
import { createLogger } from "../logging/logger.js";
import {
  STATE_KEYS,
  type StateKey,
  type SaveFailure,
} from "./published-state-repository.js";
import {
  checkValue,
  type SnapshotValidator,
  type ValidationStage,
} from "./published-state-read.js";
import {
  connectionCoordination,
  type ConnectionCoordination,
} from "./connection-coordination.js";
import { classifyDatabaseError } from "./errors.js";
import { validateSchema } from "./schema.js";
import {
  isCacheEntry,
  type CacheEntry,
  type CacheReadEvidence,
  type CacheReadResult,
  type CacheConditionalSaveRequest,
  type CacheSaveResult,
} from "./cache-entry.js";
export type {
  CacheEntry,
  CacheReadEvidence,
  CacheReadResult,
  CacheConditionalSaveRequest,
  CacheSaveResult,
  CacheAdoptionDecision,
} from "./cache-entry.js";

type Cell = string | number | bigint | Buffer | null;
interface Row {
  exists: boolean;
  json: Cell;
}
interface Attempt {
  before: Row;
  planned: string;
  failure?: SaveFailure;
}
interface EvidenceRecord {
  connection: Database.Database;
  coordination: ConnectionCoordination;
  stateKey: StateKey;
  row: Row;
  consumed: boolean;
}
const evidenceRecords = new WeakMap<CacheReadEvidence, EvidenceRecord>();
const cacheAttempts = new WeakMap<Database.Database, Map<StateKey, Attempt>>();
class StaleCacheEvidence extends Error {}
function key(value: string): value is StateKey {
  return (STATE_KEYS as readonly string[]).includes(value);
}
function same(a: Row, b: Row): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;
  if (Buffer.isBuffer(a.json) || Buffer.isBuffer(b.json))
    return (
      Buffer.isBuffer(a.json) &&
      Buffer.isBuffer(b.json) &&
      a.json.equals(b.json)
    );
  return a.json === b.json;
}
function failure(error: unknown): SaveFailure {
  if (error instanceof StaleCacheEvidence)
    return { scope: "state", reason: "stale_cache_evidence" };
  const code = (error as { code?: string })?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"))
    return { scope: "state", layer: "L3", reason: "write_constraint" };
  try {
    const status = classifyDatabaseError(error);
    return { scope: "database", layer: status.layer, reason: status.reason };
  } catch {
    return { scope: "database", layer: "L4", reason: "storage_failure" };
  }
}
type Checked<T> =
  | { outcome: "found"; entry: CacheEntry<T> }
  | { outcome: "invalid"; stage: ValidationStage; reason: string }
  | {
      outcome: "validator_error";
      stage: "schema" | "semantic";
      reason: string;
    };
function check<T>(cell: Cell, validator: SnapshotValidator<T>): Checked<T> {
  if (typeof cell !== "string")
    return {
      outcome: "invalid",
      stage: "schema",
      reason: "cache_json_not_text",
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cell);
  } catch {
    return { outcome: "invalid", stage: "json_parse", reason: "invalid_json" };
  }
  if (!isCacheEntry(parsed))
    return {
      outcome: "invalid",
      stage: "schema",
      reason: "invalid_cache_entry",
    };
  const domain = checkValue(parsed.data, validator);
  if (domain.kind === "error")
    return {
      outcome: "validator_error",
      stage: domain.stage,
      reason: domain.reason,
    };
  if (domain.kind === "invalid")
    return { outcome: "invalid", stage: domain.stage, reason: domain.reason };
  return { outcome: "found", entry: { ...parsed, data: domain.value } };
}
/** Borrows BackendStore's Connection. No blind save/delete, TTL or Domain adoption. */
export class BackendCacheRepository {
  private readonly coordination: ConnectionCoordination;
  private readonly pending: Map<StateKey, Attempt>;
  constructor(
    private readonly db: Database.Database,
    private readonly logger: Pick<Logger, "warn" | "error"> = createLogger(),
  ) {
    this.coordination = connectionCoordination(db);
    let pending = cacheAttempts.get(db);
    if (!pending) {
      pending = new Map();
      cacheAttempts.set(db, pending);
    }
    this.pending = pending;
  }
  /** Unknown keys violate the typed input contract; never classify them as DB failure. */
  read<T>(
    stateKey: StateKey,
    validator: SnapshotValidator<T>,
  ): CacheReadResult<T> {
    if (!key(stateKey)) throw new TypeError("Unsupported cache state key");
    if (this.coordination.connectionUnresolved) return this.readUnresolved();
    if (this.coordination.busy)
      return {
        outcome: "database_error",
        layer: "L1",
        reason: "connection_busy",
      };
    if (this.coordination.blocked)
      return this.readFailure(this.coordination.blocked);
    if (this.pending.has(stateKey))
      return { outcome: "pending", reason: "commit_result_unknown" };
    this.coordination.busy = true;
    try {
      let row: Row;
      try {
        if (!this.resolved()) return this.readUnresolved();
        this.db.exec("BEGIN");
        validateSchema(this.db);
        row = this.readRow(stateKey);
        this.db.exec("COMMIT");
        if (!this.resolved()) return this.readUnresolved();
      } catch (error) {
        if (!this.resolveTransaction()) return this.readUnresolved();
        return this.readFailure(failure(error));
      }
      let checked: Checked<T> | undefined;
      if (row.exists) checked = check(row.json, validator); // Outside Read Transaction, still inside shared gate.
      if (checked?.outcome === "validator_error") {
        this.log("error", stateKey, checked.stage);
        return checked;
      }
      if (checked?.outcome === "invalid")
        this.log("warn", stateKey, checked.stage);
      try {
        if (!this.db.open || !this.resolved()) return this.readUnresolved();
      } catch {
        return this.readUnresolved();
      }
      const evidence = Object.freeze(Object.create(null)) as CacheReadEvidence;
      evidenceRecords.set(evidence, {
        connection: this.db,
        coordination: this.coordination,
        stateKey,
        row,
        consumed: false,
      });
      return checked
        ? { ...checked, evidence }
        : { outcome: "empty", evidence };
    } finally {
      this.coordination.busy = false;
    }
  }
  saveConditionally<T>(
    request: CacheConditionalSaveRequest<T>,
  ): CacheSaveResult {
    if (!key(request.stateKey))
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "unsupported_state",
      };
    let refusal = this.refusal(request.stateKey);
    if (refusal) return refusal;
    let planned: string;
    try {
      if (!isCacheEntry(request.entry)) throw new TypeError();
      const serialized = JSON.stringify(
        request.entry,
        (_key, value: unknown) => {
          // Refuse silent omissions/coercions of non-JSON values. toJSON output is
          // checked too, and the resulting envelope is revalidated below.
          if (
            typeof value === "undefined" ||
            typeof value === "function" ||
            typeof value === "symbol" ||
            typeof value === "bigint" ||
            (typeof value === "number" && !Number.isFinite(value))
          )
            throw new TypeError();
          return value;
        },
      ); // Exactly once, before any Transaction.
      if (
        typeof serialized !== "string" ||
        !isCacheEntry(JSON.parse(serialized))
      )
        throw new TypeError();
      planned = serialized;
    } catch {
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "invalid_cache_entry",
      };
    }
    if (request.adoption?.outcome !== "adopt")
      return {
        outcome: "not_saved",
        scope: "state",
        reason: "adoption_not_confirmed",
      };
    const record = evidenceRecords.get(request.evidence);
    if (
      !record ||
      record.connection !== this.db ||
      record.coordination !== this.coordination ||
      record.stateKey !== request.stateKey ||
      !this.db.open
    )
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "invalid_cache_evidence",
      };
    if (record.consumed)
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "consumed_cache_evidence",
      };
    refusal = this.refusal(request.stateKey);
    if (refusal) return refusal;
    this.coordination.busy = true;
    let attempt: Attempt | undefined;
    try {
      if (!this.resolved()) return this.unresolved();
      // All preflight refusals leave the evidence intact. Every BEGIN attempt consumes it.
      record.consumed = true;
      this.db.exec("BEGIN IMMEDIATE");
      validateSchema(this.db);
      const before = this.readRow(request.stateKey);
      if (!same(before, record.row)) throw new StaleCacheEvidence();
      attempt = { before, planned };
      this.pending.set(request.stateKey, attempt);
      const unchanged = same(before, { exists: true, json: planned });
      if (!unchanged)
        this.db
          .prepare(
            "INSERT INTO backend_cache (state_key,cache_json) VALUES (?,?) ON CONFLICT(state_key) DO UPDATE SET cache_json=excluded.cache_json",
          )
          .run(request.stateKey, planned);
      this.db.exec("COMMIT");
      if (!this.resolved()) return this.unresolved();
      this.pending.delete(request.stateKey);
      return unchanged
        ? { outcome: "unchanged" }
        : { outcome: "saved", reconciled: false };
    } catch (error) {
      const problem = failure(error);
      if (attempt) attempt.failure = problem;
      if (!this.resolveTransaction()) return this.unresolved();
      const result = attempt
        ? this.compare(request.stateKey, attempt)
        : { outcome: "not_saved" as const, ...problem };
      if (result.outcome !== "saved") this.blockIfFatal(problem);
      return result;
    } finally {
      this.coordination.busy = false;
    }
  }
  /** Read-only comparison of a pending attempt; never a retry or a write. */
  reconcile(stateKey: StateKey): CacheSaveResult {
    if (!key(stateKey))
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "unsupported_state",
      };
    if (this.coordination.connectionUnresolved) return this.unresolved();
    if (this.coordination.busy)
      return {
        outcome: "unknown",
        scope: "database",
        reason: "connection_busy",
      };
    if (this.coordination.blocked)
      return {
        outcome: "unknown",
        scope: "database",
        reason: this.coordination.blocked.reason,
      };
    const attempt = this.pending.get(stateKey);
    if (!attempt)
      return {
        outcome: "not_saved",
        scope: "state",
        reason: "no_pending_attempt",
      };
    this.coordination.busy = true;
    try {
      return this.compare(stateKey, attempt);
    } finally {
      this.coordination.busy = false;
    }
  }
  private compare(stateKey: StateKey, attempt: Attempt): CacheSaveResult {
    try {
      if (!this.resolved()) return this.unresolved();
      this.db.exec("BEGIN");
      validateSchema(this.db);
      const actual = this.readRow(stateKey);
      this.db.exec("COMMIT");
      if (!this.resolved()) return this.unresolved();
      const expected: Row = { exists: true, json: attempt.planned };
      // Equal before/after images cannot prove whether this operation committed.
      if (same(attempt.before, expected))
        return {
          outcome: "unknown",
          scope: "state",
          reason: "indistinguishable_cache_images",
        };
      if (same(actual, expected)) {
        this.pending.delete(stateKey);
        return { outcome: "saved", reconciled: true };
      }
      if (same(actual, attempt.before)) {
        this.pending.delete(stateKey);
        return {
          outcome: "not_saved",
          ...(attempt.failure ?? { scope: "state", reason: "write_not_saved" }),
        };
      }
      return {
        outcome: "unknown",
        scope: "state",
        reason: "unexpected_cache_row",
      };
    } catch (error) {
      if (!this.resolveTransaction()) return this.unresolved();
      const problem = failure(error);
      this.blockIfFatal(problem);
      return {
        outcome: "unknown",
        scope: problem.scope === "state" ? "state" : "database",
        reason: "cache_reconciliation_failed",
      };
    }
  }
  private readRow(stateKey: StateKey): Row {
    const row = this.db
      .prepare("SELECT cache_json FROM backend_cache WHERE state_key=?")
      .safeIntegers(true)
      .get(stateKey) as { cache_json: Cell } | undefined;
    return row
      ? {
          exists: true,
          json: Buffer.isBuffer(row.cache_json)
            ? Buffer.from(row.cache_json)
            : row.cache_json,
        }
      : { exists: false, json: null };
  }
  private refusal(stateKey: StateKey): CacheSaveResult | undefined {
    if (this.coordination.connectionUnresolved) return this.unresolved();
    if (this.coordination.busy)
      return {
        outcome: "not_saved",
        scope: "database",
        layer: "L1",
        reason: "connection_busy",
      };
    if (this.coordination.blocked)
      return { outcome: "not_saved", ...this.coordination.blocked };
    if (this.pending.has(stateKey))
      return {
        outcome: "unknown",
        scope: "state",
        reason: "commit_result_unknown",
      };
  }
  private resolved() {
    return this.db.inTransaction === false;
  }
  private resolveTransaction(): boolean {
    try {
      const active = this.db.inTransaction;
      if (active === false) return true;
      if (active !== true) return false;
    } catch {
      return false;
    }
    try {
      this.db.exec("ROLLBACK");
    } catch {
      /* Resolve from the actual final state, including post-Rollback notifications. */
    }
    try {
      return this.resolved();
    } catch {
      return false;
    }
  }
  private unresolved(): CacheSaveResult {
    this.coordination.connectionUnresolved = true;
    return {
      outcome: "unknown",
      scope: "database",
      reason: "transaction_unresolved",
    };
  }
  private readUnresolved(): CacheReadResult<never> {
    this.unresolved();
    return {
      outcome: "database_error",
      layer: "L4",
      reason: "transaction_unresolved",
    };
  }
  private blockIfFatal(problem: SaveFailure) {
    if (
      problem.scope === "database" &&
      (problem.layer === "L3" || problem.layer === "L4")
    )
      this.coordination.blocked = problem;
  }
  private readFailure(problem: SaveFailure): CacheReadResult<never> {
    this.blockIfFatal(problem);
    return {
      outcome: "database_error",
      layer: problem.layer ?? "L4",
      reason: problem.reason,
    };
  }
  private log(
    level: "warn" | "error",
    stateKey: StateKey,
    stage: ValidationStage,
  ) {
    try {
      this.logger[level](
        {
          event:
            level === "warn"
              ? "cache_validation_failed"
              : "cache_validator_error",
          stateKey,
          stage,
        },
        "Cache validation result",
      );
    } catch {
      /* Logging does not change Cache usability. */
    }
  }
}
