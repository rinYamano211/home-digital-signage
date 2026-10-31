import type Database from "better-sqlite3";
import {
  STATE_KEYS,
  type StateKey,
  type SaveFailure,
} from "./published-state-repository.js";
import {
  connectionCoordination,
  type ConnectionCoordination,
} from "./connection-coordination.js";
import { validateSchema } from "./schema.js";
import { classifyDatabaseError } from "./errors.js";
import {
  controlState,
  type AcquisitionControlState,
} from "../acquisition/control-state.js";
export type { AcquisitionControlState } from "../acquisition/control-state.js";

declare const trialBrand: unique symbol;
declare const evidenceBrand: unique symbol;
declare const authorizationBrand: unique symbol;
export interface ControlAttempt {
  readonly [trialBrand]: true;
}
export interface ControlReadEvidence {
  readonly [evidenceBrand]: true;
}
export interface InitialControlSaveAuthorization {
  readonly [authorizationBrand]: true;
}
export type ControlReadResult =
  | {
      outcome: "found";
      state: AcquisitionControlState;
      evidence: ControlReadEvidence;
    }
  | { outcome: "empty"; evidence: ControlReadEvidence }
  | {
      outcome: "invalid";
      stage: "json_parse" | "schema" | "semantic";
      reason: string;
    }
  | {
      outcome: "database_error";
      layer: "L1" | "L2" | "L3" | "L4";
      reason: string;
    }
  | { outcome: "pending"; reason: "commit_result_unknown" };
export type ControlSaveResult =
  | { outcome: "saved"; reconciled: boolean }
  | { outcome: "unchanged" }
  | ({ outcome: "not_saved" } & SaveFailure)
  | { outcome: "unknown"; scope: "state" | "database"; reason: string };
export type ControlSaveRequest = {
  stateKey: StateKey;
  evidence: ControlReadEvidence;
  nextState: AcquisitionControlState;
} & (
  | { mode: "update" }
  | { mode: "initialize"; authorization: InitialControlSaveAuthorization }
);
export interface InitialControlFacts {
  httpResult: "success" | "failure" | "unclassified";
  nextState: AcquisitionControlState;
  databaseHealthy: boolean;
  acquisitionConditionsSatisfied: boolean;
  eligibility:
    | {
        kind: "confirmed_new";
        pastRecordsAbsent: boolean;
        outsideInitialization: boolean;
        inputsComplete: boolean;
        newnessConfirmed: boolean;
      }
    | { kind: "conservative_wait_complete"; waitCompleted: boolean }
    | { kind: "unknown" };
}
interface Trial {
  owner: ControlAttemptManager;
  stateKey: StateKey;
  active: boolean;
}
interface Row {
  exists: boolean;
  json: unknown;
}
interface EvidenceRecord {
  owner: AcquisitionControlRepository;
  db: Database.Database;
  trial: Trial;
  row: Row;
  consumed: boolean;
  authorize: (
    facts: InitialControlFacts,
  ) => InitialControlSaveAuthorization | null;
}
interface AuthorizationRecord {
  evidence: ControlReadEvidence;
  trial: Trial;
  epoch: number;
  consumed: boolean;
}
const trials = new WeakMap<ControlAttempt, Trial>();
const evidenceRecords = new WeakMap<ControlReadEvidence, EvidenceRecord>();
const authorizations = new WeakMap<
  InitialControlSaveAuthorization,
  AuthorizationRecord
>();
const token = <T>(): T => Object.freeze(Object.create(null)) as T;
const allowed = (key: string): key is StateKey =>
  (STATE_KEYS as readonly string[]).includes(key);

/** Application-owned, Process-local lifecycle/authorization mechanism. The facts
 * must come from the future Coordinator; they are not HTTP or newness discovery.
 */
export class ControlAttemptManager {
  private readonly active = new Map<StateKey, ControlAttempt>();
  private shuttingDown = false;
  private blocked = false;
  private epoch = 0;
  private cleanup?: {
    deadlineMonotonicMs: number;
    lifecycleCleanupAllowed: boolean;
  };
  constructor(private readonly now: () => number = () => performance.now()) {}
  beginAttempt(stateKey: StateKey): ControlAttempt {
    if (!allowed(stateKey)) throw new TypeError("Unsupported State Key");
    if (this.shuttingDown || this.blocked || this.active.has(stateKey))
      throw new Error("Acquisition attempt unavailable");
    const value = token<ControlAttempt>();
    trials.set(value, { owner: this, stateKey, active: true });
    this.active.set(stateKey, value);
    return value;
  }
  endAttempt(value: ControlAttempt): void {
    const trial = trials.get(value);
    if (!trial || trial.owner !== this)
      throw new TypeError("Invalid acquisition attempt");
    trial.active = false;
    if (this.active.get(trial.stateKey) === value)
      this.active.delete(trial.stateKey);
  }
  current(stateKey: StateKey): ControlAttempt | undefined {
    return this.active.get(stateKey);
  }
  beginShutdown(cleanup?: {
    deadlineMonotonicMs: number;
    lifecycleCleanupAllowed: boolean;
  }): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.epoch++;
    this.cleanup = cleanup ? { ...cleanup } : undefined;
  }
  blockWrites(): void {
    this.blocked = true;
    this.epoch++;
  }
  canWrite(trial: Trial, initialize: boolean): boolean {
    if (!trial.active || trial.owner !== this || this.blocked) return false;
    if (!this.shuttingDown) return true;
    if (initialize) return false;
    const now = this.now();
    return (
      this.cleanup?.lifecycleCleanupAllowed === true &&
      Number.isFinite(now) &&
      Number.isFinite(this.cleanup.deadlineMonotonicMs) &&
      now < this.cleanup.deadlineMonotonicMs
    );
  }
  authorizationEpoch(): number {
    return this.epoch;
  }
  authorizeInitial(
    evidence: ControlReadEvidence,
    facts: InitialControlFacts,
  ): InitialControlSaveAuthorization | null {
    const record = evidenceRecords.get(evidence);
    if (
      !record ||
      record.trial.owner !== this ||
      !this.canWrite(record.trial, true)
    )
      return null;
    return record.authorize(facts);
  }
}
interface Guard {
  changes: number;
  version: number;
}
interface Attempt {
  owner: AcquisitionControlRepository;
  before: Row;
  planned: string;
  guard?: Guard;
  failure?: SaveFailure;
}
const attempts = new WeakMap<Database.Database, Map<StateKey, Attempt>>();
class StaleControlEvidence extends Error {}
function same(a: Row, b: Row): boolean {
  return a.exists === b.exists && (!a.exists || a.json === b.json);
}
function failure(error: unknown): SaveFailure {
  if (error instanceof StaleControlEvidence)
    return { scope: "state", reason: "stale_control_evidence" };
  const code = (error as { code?: string })?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"))
    return { scope: "state", layer: "L3", reason: "write_constraint" };
  try {
    const s = classifyDatabaseError(error);
    return { scope: "database", layer: s.layer, reason: s.reason };
  } catch {
    return { scope: "database", layer: "L4", reason: "storage_failure" };
  }
}
function checked(
  row: Row,
):
  | AcquisitionControlState
  | Exclude<
      ControlReadResult,
      { outcome: "found" | "empty" | "pending" | "database_error" }
    > {
  if (typeof row.json !== "string")
    return {
      outcome: "invalid",
      stage: "schema",
      reason: "control_json_not_text",
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.json);
  } catch {
    return { outcome: "invalid", stage: "json_parse", reason: "invalid_json" };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    typeof (parsed as AcquisitionControlState).consecutiveFailures !==
      "number" ||
    typeof (parsed as AcquisitionControlState).nextAttemptAt !== "string"
  )
    return {
      outcome: "invalid",
      stage: "schema",
      reason: "invalid_control_structure",
    };
  return (
    controlState(parsed) ?? {
      outcome: "invalid",
      stage: "semantic",
      reason: "invalid_control_values",
    }
  );
}
/** Borrows the Store Connection. No close, HTTP, retry, Quota or publication. */
export class AcquisitionControlRepository {
  private readonly coordination: ConnectionCoordination;
  private readonly pending: Map<StateKey, Attempt>;
  private readonly latestEvidence = new Map<StateKey, ControlReadEvidence>();
  constructor(
    private readonly db: Database.Database,
    readonly context = new ControlAttemptManager(),
  ) {
    this.coordination = connectionCoordination(db);
    let pending = attempts.get(db);
    if (!pending) {
      pending = new Map();
      attempts.set(db, pending);
    }
    this.pending = pending;
  }
  read(stateKey: StateKey): ControlReadResult {
    if (!allowed(stateKey))
      throw new TypeError("Unsupported Control State Key");
    const refusal = this.refusal(stateKey);
    if (refusal)
      return refusal.outcome === "unknown" && refusal.scope === "state"
        ? { outcome: "pending", reason: "commit_result_unknown" }
        : this.readFailure(refusal);
    const trial = this.activeTrial(stateKey);
    if (!trial) throw new TypeError("Active acquisition attempt required");
    this.coordination.busy = true;
    try {
      let row: Row;
      try {
        if (!this.resolved()) return this.readFailure(this.unresolved());
        this.db.exec("BEGIN");
        validateSchema(this.db);
        row = this.row(stateKey);
        this.db.exec("COMMIT");
        if (!this.resolved()) return this.readFailure(this.unresolved());
      } catch (error) {
        if (!this.resolveTransaction())
          return this.readFailure(this.unresolved());
        return this.readFailure(failure(error));
      }
      const state = row.exists ? checked(row) : undefined;
      if (state && "outcome" in state) return state;
      const evidence = token<ControlReadEvidence>();
      const record: EvidenceRecord = {
        owner: this,
        db: this.db,
        trial,
        row,
        consumed: false,
        authorize: (facts) => this.issueAuthorization(evidence, facts),
      };
      evidenceRecords.set(evidence, record);
      this.latestEvidence.set(stateKey, evidence);
      return state
        ? { outcome: "found", state, evidence }
        : { outcome: "empty", evidence };
    } finally {
      this.coordination.busy = false;
    }
  }
  private issueAuthorization(
    evidence: ControlReadEvidence,
    facts: InitialControlFacts,
  ): InitialControlSaveAuthorization | null {
    const record = evidenceRecords.get(evidence);
    if (
      !record ||
      record.owner !== this ||
      record.row.exists ||
      record.consumed ||
      this.latestEvidence.get(record.trial.stateKey) !== evidence ||
      this.refusal(record.trial.stateKey)
    )
      return null;
    this.coordination.busy = true;
    try {
      try {
        const eligibility = facts.eligibility;
        const eligible =
          eligibility?.kind === "confirmed_new"
            ? eligibility.pastRecordsAbsent === true &&
              eligibility.outsideInitialization === true &&
              eligibility.inputsComplete === true &&
              eligibility.newnessConfirmed === true
            : eligibility?.kind === "conservative_wait_complete" &&
              eligibility.waitCompleted === true;
        if (
          !eligible ||
          (facts.httpResult !== "success" && facts.httpResult !== "failure") ||
          facts.databaseHealthy !== true ||
          facts.acquisitionConditionsSatisfied !== true ||
          !controlState(facts.nextState) ||
          !this.context.canWrite(record.trial, true)
        )
          return null;
      } catch {
        // Application fact/candidate errors are not SQLite corruption.
        return null;
      }
      if (!this.resolved() || !this.db.open) {
        this.unresolved();
        return null;
      }
      // Re-read immediately at authorization issuance. Its absence alone never
      // proves newness: the Application's positive eligibility is also required.
      this.db.exec("BEGIN");
      validateSchema(this.db);
      const row = this.row(record.trial.stateKey);
      this.db.exec("COMMIT");
      if (!this.resolved()) {
        this.unresolved();
        return null;
      }
      if (row.exists || !this.context.canWrite(record.trial, true)) return null;
      const authorization = token<InitialControlSaveAuthorization>();
      authorizations.set(authorization, {
        evidence,
        trial: record.trial,
        epoch: this.context.authorizationEpoch(),
        consumed: false,
      });
      return authorization;
    } catch (error) {
      if (!this.resolveTransaction()) this.unresolved();
      else this.blockFatal(failure(error));
      return null;
    } finally {
      this.coordination.busy = false;
    }
  }
  saveConditionally(request: ControlSaveRequest): ControlSaveResult {
    // Own the shared gate before caller getters/validation can reenter storage.
    const unavailable = this.refusal();
    if (unavailable) return unavailable;
    this.coordination.busy = true;
    try {
      const stateKey = request.stateKey;
      if (!allowed(stateKey))
        return {
          outcome: "not_saved",
          scope: "input",
          reason: "unsupported_state",
        };
      if (this.pending.has(stateKey))
        return {
          outcome: "unknown",
          scope: "state",
          reason: "commit_result_unknown",
        };
      const mode = request.mode;
      const evidence = request.evidence;
      const nextState = request.nextState;
      const copy =
        mode === "initialize"
          ? {
              mode,
              stateKey,
              evidence,
              nextState,
              authorization: request.authorization,
            }
          : { mode, stateKey, evidence, nextState };
      return this.save(copy);
    } catch {
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "invalid_control_request",
      };
    } finally {
      this.coordination.busy = false;
    }
  }
  private save(request: ControlSaveRequest): ControlSaveResult {
    const refuse = (reason: string): ControlSaveResult => ({
      outcome: "not_saved",
      scope: "input",
      reason,
    });
    let planned: string;
    try {
      const state = controlState(request.nextState);
      if (!state) return refuse("invalid_control_state");
      planned = JSON.stringify(state);
    } catch {
      return refuse("invalid_control_state");
    }
    const record = evidenceRecords.get(request.evidence);
    if (
      !record ||
      record.owner !== this ||
      record.db !== this.db ||
      record.trial !== this.activeTrial(request.stateKey) ||
      record.trial.stateKey !== request.stateKey ||
      !this.db.open
    )
      return refuse("invalid_control_evidence");
    if (record.consumed) return refuse("consumed_control_evidence");
    const initialize = request.mode === "initialize";
    if (!initialize && request.mode !== "update")
      return refuse("invalid_save_mode");
    if (!this.context.canWrite(record.trial, initialize))
      return refuse("control_write_stopped");
    if (initialize === record.row.exists)
      return refuse("wrong_control_save_mode");
    const authorization = initialize
      ? authorizations.get(request.authorization)
      : undefined;
    if (
      initialize &&
      (!authorization ||
        authorization.evidence !== request.evidence ||
        authorization.trial !== record.trial ||
        authorization.epoch !== this.context.authorizationEpoch() ||
        authorization.consumed)
    )
      return refuse("invalid_initial_authorization");
    let attempt: Attempt | undefined;
    let commitStarted = false;
    try {
      if (!this.resolved()) return this.unresolved();
      // Recheck after all caller-provided getters/validation, before consuming.
      if (!this.context.canWrite(record.trial, initialize))
        return refuse("control_write_stopped");
      record.consumed = true;
      if (authorization) authorization.consumed = true;
      this.db.exec("BEGIN IMMEDIATE");
      validateSchema(this.db);
      const before = this.row(request.stateKey);
      if (!same(before, record.row)) throw new StaleControlEvidence();
      attempt = { owner: this, before, planned };
      this.pending.set(request.stateKey, attempt);
      const unchanged = before.exists && before.json === planned;
      if (!unchanged) {
        if (initialize)
          this.db
            .prepare(
              "INSERT INTO acquisition_control (state_key,control_json) VALUES (?,?)",
            )
            .run(request.stateKey, planned);
        else {
          const result = this.db
            .prepare(
              "UPDATE acquisition_control SET control_json=? WHERE state_key=?",
            )
            .run(planned, request.stateKey);
          if (result.changes !== 1) throw new StaleControlEvidence();
        }
      }
      attempt.guard = this.guard();
      commitStarted = true;
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
      // No COMMIT was attempted: resolved rollback proves non-reflection.
      if (attempt && !commitStarted) {
        this.pending.delete(request.stateKey);
        this.blockFatal(problem);
        return { outcome: "not_saved", ...problem };
      }
      const result = attempt
        ? this.compare(request.stateKey, attempt)
        : { outcome: "not_saved" as const, ...problem };
      if (result.outcome !== "saved") this.blockFatal(problem);
      return result;
    }
  }
  /** Read-only proof for this Process/Repository's pending attempt. Never re-save. */
  reconcile(stateKey: StateKey): ControlSaveResult {
    if (!allowed(stateKey))
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "unsupported_state",
      };
    if (this.coordination.connectionUnresolved) return this.unresolved();
    if (this.coordination.busy || this.coordination.blocked)
      return {
        outcome: "unknown",
        scope: "database",
        reason: "connection_unavailable",
      };
    const attempt = this.pending.get(stateKey);
    if (!attempt || attempt.owner !== this)
      return {
        outcome: "not_saved",
        scope: "state",
        reason: "no_owned_pending_attempt",
      };
    this.coordination.busy = true;
    try {
      return this.compare(stateKey, attempt);
    } finally {
      this.coordination.busy = false;
    }
  }
  private compare(stateKey: StateKey, attempt: Attempt): ControlSaveResult {
    const unknown = (reason: string): ControlSaveResult => ({
      outcome: "unknown",
      scope: "state",
      reason,
    });
    try {
      if (!this.resolved()) return this.unresolved();
      this.db.exec("BEGIN");
      validateSchema(this.db);
      const current = this.row(stateKey);
      const guard = this.guard();
      this.db.exec("COMMIT");
      if (!this.resolved()) return this.unresolved();
      // total_changes/data_version detect writes outside the held per-State
      // pending gate, including same-JSON ABA in fault injection. No durable ID.
      if (
        !attempt.guard ||
        guard.changes !== attempt.guard.changes ||
        guard.version !== attempt.guard.version
      )
        return unknown("control_writer_not_excluded");
      if (same(attempt.before, { exists: true, json: attempt.planned }))
        return unknown("indistinguishable_control_images");
      if (same(current, { exists: true, json: attempt.planned })) {
        this.pending.delete(stateKey);
        return { outcome: "saved", reconciled: true };
      }
      if (same(current, attempt.before)) {
        this.pending.delete(stateKey);
        return {
          outcome: "not_saved",
          ...(attempt.failure ?? { scope: "state", reason: "write_not_saved" }),
        };
      }
      return unknown("unexpected_control_row");
    } catch (error) {
      if (!this.resolveTransaction()) return this.unresolved();
      const problem = failure(error);
      this.blockFatal(problem);
      return {
        outcome: "unknown",
        scope: problem.scope === "state" ? "state" : "database",
        reason: "control_reconciliation_failed",
      };
    }
  }
  private guard(): Guard {
    const row = this.db
      .prepare("SELECT total_changes() AS n")
      .safeIntegers(true)
      .get() as { n: bigint };
    const changes = Number(row.n);
    const version = this.db.pragma("data_version", { simple: true });
    if (
      !Number.isSafeInteger(changes) ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version)
    )
      throw new Error("Unknown write guard");
    return { changes, version };
  }
  private activeTrial(stateKey: StateKey): Trial | undefined {
    const token = this.context.current(stateKey);
    const trial = token && trials.get(token);
    return trial?.active && trial.owner === this.context ? trial : undefined;
  }
  private row(stateKey: StateKey): Row {
    const row = this.db
      .prepare("SELECT control_json FROM acquisition_control WHERE state_key=?")
      .get(stateKey) as { control_json: unknown } | undefined;
    return row
      ? { exists: true, json: row.control_json }
      : { exists: false, json: null };
  }
  private refusal(
    stateKey?: StateKey,
  ):
    Exclude<ControlSaveResult, { outcome: "saved" | "unchanged" }> | undefined {
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
    if (stateKey !== undefined && this.pending.has(stateKey))
      return {
        outcome: "unknown",
        scope: "state",
        reason: "commit_result_unknown",
      };
  }
  private resolved(): boolean {
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
      /* Verify actual state after notification errors. */
    }
    try {
      return this.resolved();
    } catch {
      return false;
    }
  }
  private unresolved(): {
    outcome: "unknown";
    scope: "database";
    reason: string;
  } {
    this.coordination.connectionUnresolved = true;
    return {
      outcome: "unknown",
      scope: "database",
      reason: "transaction_unresolved",
    };
  }
  private blockFatal(problem: SaveFailure): void {
    if (
      problem.scope === "database" &&
      (problem.layer === "L3" || problem.layer === "L4")
    )
      this.coordination.blocked = problem;
  }
  private readFailure(
    problem: SaveFailure | { reason: string },
  ): ControlReadResult {
    if ("scope" in problem) this.blockFatal(problem);
    return {
      outcome: "database_error",
      layer: "layer" in problem ? (problem.layer ?? "L4") : "L4",
      reason: problem.reason,
    };
  }
}
