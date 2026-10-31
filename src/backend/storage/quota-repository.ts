import type Database from "better-sqlite3";
import {
  connectionCoordination,
  type ConnectionCoordination,
} from "./connection-coordination.js";
import { classifyDatabaseError } from "./errors.js";
import { validateSchema } from "./schema.js";
import {
  QuotaGuard,
  TOMORROW_IO,
  quotaTimestamp,
  type QuotaProvider,
  type QuotaTrust,
  type QuotaHistory,
  type QuotaMetadata,
  type QuotaConsumption,
  type QuotaInspectionResult,
} from "../quota/quota-guard.js";

declare const attemptBrand: unique symbol;
declare const reservationBrand: unique symbol;
export interface QuotaAttempt {
  readonly [attemptBrand]: true;
}
export interface QuotaReservationEvidence {
  readonly [reservationBrand]: true;
}
export interface QuotaReservation {
  readonly providerKey: QuotaProvider;
  readonly sequence: number;
  readonly reservedAtMs: number;
  readonly measurementStartedNs: bigint;
}
export type QuotaReservationResult =
  | {
      outcome: "saved";
      evidence: QuotaReservationEvidence;
      reconciled: boolean;
    }
  | { outcome: "quota_blocked"; reason: string; recheckAtMs?: number }
  | {
      outcome: "not_saved";
      reason: string;
      scope: "input" | "provider" | "database";
    }
  | { outcome: "unknown"; reason: string; scope: "provider" | "database" };
export interface QuotaReservationRequest {
  providerKey: QuotaProvider;
  attempt: QuotaAttempt;
  trust: () => QuotaTrust;
}
export interface QuotaProvisioningConfirmation {
  clockTrusted: boolean;
  pastUseOutsideQuotaPeriodsConfirmed: boolean;
  safetyMarginConfirmed: boolean;
  exclusiveKeyUseConfirmed: boolean;
}
interface Trial {
  owner: QuotaRepository;
  db: Database.Database;
  providerKey: QuotaProvider;
  active: boolean;
  attempted: boolean;
}
interface EvidenceRecord {
  trial: Trial;
  reservation: QuotaReservation;
}
interface WriteGuard {
  changes: bigint;
  version: number;
}
interface Pending {
  owner: QuotaRepository;
  trial: Trial;
  before: string;
  expected: string;
  reservation: QuotaReservation;
  guard?: WriteGuard;
}
const trials = new WeakMap<QuotaAttempt, Trial>();
const evidenceRegistry = new WeakMap<
  QuotaReservationEvidence,
  EvidenceRecord
>();
const provisioningByConnection = new WeakMap<Database.Database, Set<string>>();
const pendingByConnection = new WeakMap<
  Database.Database,
  Map<string, Pending>
>();
const opaque = <T>(): T => Object.freeze(Object.create(null)) as T;
const untrusted: QuotaTrust = Object.freeze({
  clockTrusted: false,
  historyTimestampsTrusted: false,
  historyComplete: false,
});
class InvalidQuotaRows extends Error {}
function integer(value: unknown): number {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new InvalidQuotaRows();
  return Number(value);
}
/** Storage only. Reservation evidence is never a Send Permit; C-Impl-4 must
 * re-evaluate Trust/stop/elapsed time before HTTP. No delete/reset/GC API.
 */
export class QuotaRepository {
  private readonly coordination: ConnectionCoordination;
  private readonly pending: Map<string, Pending>;
  private readonly provisioningUnresolved: Set<string>;
  private readonly active = new Map<QuotaProvider, QuotaAttempt>();
  private readonly guard = new QuotaGuard();
  constructor(private readonly db: Database.Database) {
    this.coordination = connectionCoordination(db);
    let pending = pendingByConnection.get(db);
    if (!pending) {
      pending = new Map();
      pendingByConnection.set(db, pending);
    }
    this.pending = pending;
    let provisioning = provisioningByConnection.get(db);
    if (!provisioning) {
      provisioning = new Set();
      provisioningByConnection.set(db, provisioning);
    }
    this.provisioningUnresolved = provisioning;
  }
  beginAttempt(providerKey: QuotaProvider): QuotaAttempt {
    if (providerKey !== TOMORROW_IO || this.active.has(providerKey))
      throw new TypeError("Quota attempt unavailable");
    const token = opaque<QuotaAttempt>();
    trials.set(token, {
      owner: this,
      db: this.db,
      providerKey,
      active: true,
      attempted: false,
    });
    this.active.set(providerKey, token);
    return token;
  }
  endAttempt(attempt: QuotaAttempt): void {
    const trial = trials.get(attempt);
    if (!trial || trial.owner !== this)
      throw new TypeError("Invalid Quota attempt");
    trial.active = false;
    if (this.active.get(trial.providerKey) === attempt)
      this.active.delete(trial.providerKey);
  }
  /** Minimal read-only handoff to a future Gate. Not a send decision or Permit. */
  inspectReservation(
    evidence: QuotaReservationEvidence,
    attempt: QuotaAttempt,
  ): QuotaReservation | null {
    const record = evidenceRegistry.get(evidence);
    const trial = trials.get(attempt);
    if (
      !record ||
      record.trial !== trial ||
      !trial ||
      trial.owner !== this ||
      trial.db !== this.db ||
      !trial.active ||
      !this.db.open ||
      this.coordination.connectionUnresolved ||
      this.coordination.blocked ||
      this.pending.has(trial.providerKey) ||
      this.provisioningUnresolved.has(trial.providerKey)
    )
      return null;
    return record.reservation;
  }
  inspect(
    providerKey: QuotaProvider,
    trust: QuotaTrust,
    now = Date.now(),
  ): QuotaInspectionResult {
    if (providerKey !== TOMORROW_IO)
      return { allowed: false, reason: "unsupported_provider" };
    const refusal = this.refusal(providerKey);
    if (refusal) return { allowed: false, reason: refusal.reason };
    this.coordination.busy = true;
    try {
      if (!this.resolved())
        return { allowed: false, reason: this.unresolved().reason };
      this.db.exec("BEGIN");
      validateSchema(this.db);
      const history = this.history(providerKey);
      this.db.exec("COMMIT");
      if (!this.resolved())
        return { allowed: false, reason: this.unresolved().reason };
      return this.guard.evaluate(providerKey, history, now, trust);
    } catch (error) {
      if (!this.resolveTransaction())
        return { allowed: false, reason: this.unresolved().reason };
      if (error instanceof InvalidQuotaRows)
        return { allowed: false, reason: "invalid_quota_rows" };
      const problem = this.problem(error);
      return { allowed: false, reason: problem.reason };
    } finally {
      this.coordination.busy = false;
    }
  }
  /** Explicit F-01 administration, distinct from DB initialization/migration.
   * The caller must verify these facts; storage cannot discover external senders.
   */
  provisionProvider(
    providerKey: QuotaProvider,
    confirmation: QuotaProvisioningConfirmation,
  ): {
    outcome: "initialized" | "not_initialized" | "unknown";
    reason?: string;
  } {
    if (providerKey !== TOMORROW_IO)
      return { outcome: "not_initialized", reason: "unsupported_provider" };
    const refusal = this.refusal(providerKey);
    if (refusal) return { outcome: "not_initialized", reason: refusal.reason };
    this.coordination.busy = true;
    let began = false;
    try {
      try {
        if (
          confirmation.clockTrusted !== true ||
          confirmation.pastUseOutsideQuotaPeriodsConfirmed !== true ||
          confirmation.safetyMarginConfirmed !== true ||
          confirmation.exclusiveKeyUseConfirmed !== true
        )
          return {
            outcome: "not_initialized",
            reason: "initial_safety_unconfirmed",
          };
      } catch {
        return {
          outcome: "not_initialized",
          reason: "initial_safety_unconfirmed",
        };
      }
      const now = Date.now();
      if (!quotaTimestamp(now))
        return { outcome: "not_initialized", reason: "invalid_timestamp" };
      if (!this.resolved())
        return { outcome: "unknown", reason: this.unresolved().reason };
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      validateSchema(this.db);
      const history = this.history(providerKey);
      if (history.metadata || history.consumptions.length) {
        this.db.exec("ROLLBACK");
        return {
          outcome: "not_initialized",
          reason: "provider_already_has_history",
        };
      }
      this.db
        .prepare(
          "INSERT INTO provider_quota_metadata (provider_key,history_status,initialized_at_ms,last_sequence) VALUES (?,'ACTIVE',?,0)",
        )
        .run(providerKey, now);
      this.db.exec("COMMIT");
      if (!this.resolved())
        return { outcome: "unknown", reason: this.unresolved().reason };
      return { outcome: "initialized" };
    } catch (error) {
      if (!this.resolveTransaction())
        return { outcome: "unknown", reason: this.unresolved().reason };
      // A provisioning commit exception never establishes initial permission.
      // Operator must inspect/reconfirm; do not reset or replay automatically.
      if (!(error instanceof InvalidQuotaRows)) this.problem(error);
      if (began) this.provisioningUnresolved.add(providerKey);
      return {
        outcome: began ? "unknown" : "not_initialized",
        reason: "provisioning_unconfirmed",
      };
    } finally {
      this.coordination.busy = false;
    }
  }
  reserve(request: QuotaReservationRequest): QuotaReservationResult {
    const connection = this.refusal();
    if (connection) return connection;
    this.coordination.busy = true;
    let attempt: Pending | undefined;
    let committing = false;
    try {
      const provider = request.providerKey;
      const token = request.attempt;
      const source = request.trust;
      const trial = trials.get(token);
      if (
        provider !== TOMORROW_IO ||
        !trial ||
        trial.owner !== this ||
        trial.db !== this.db ||
        trial.providerKey !== provider ||
        !trial.active ||
        trial.attempted ||
        !this.db.open
      )
        return {
          outcome: "not_saved",
          scope: "input",
          reason: "invalid_quota_attempt",
        };
      if (this.provisioningUnresolved.has(provider))
        return {
          outcome: "unknown",
          scope: "provider",
          reason: "provisioning_unconfirmed",
        };
      if (this.pending.has(provider))
        return {
          outcome: "unknown",
          scope: "provider",
          reason: "commit_result_unknown",
        };
      if (!this.resolved()) return this.unresolved();
      const trusted = this.trust(source);
      const reason = this.trustFailure(trusted);
      if (reason) return { outcome: "quota_blocked", reason };
      // Keep these adjacent: Timestamp acquisition and all Tx-Q work are inside
      // F-02 elapsed time. Do not restart the origin at COMMIT or reconciliation.
      const measurementStartedNs = process.hrtime.bigint();
      const reservedAtMs = Date.now();
      if (!quotaTimestamp(reservedAtMs) || measurementStartedNs < 0n)
        return { outcome: "quota_blocked", reason: "invalid_timestamp" };
      if (!trial.active)
        return {
          outcome: "not_saved",
          scope: "input",
          reason: "invalid_quota_attempt",
        };
      trial.attempted = true;
      this.db.exec("BEGIN IMMEDIATE");
      validateSchema(this.db);
      const currentTrust = this.trust(source);
      const before = this.history(provider);
      const result = this.guard.evaluate(
        provider,
        before,
        reservedAtMs,
        currentTrust,
      );
      if (!result.allowed || !trial.active) {
        this.db.exec("ROLLBACK");
        return {
          outcome: "quota_blocked",
          reason: trial.active ? result.reason : "invalid_quota_attempt",
          ...(result.recheckAtMs === undefined
            ? {}
            : { recheckAtMs: result.recheckAtMs }),
        };
      }
      const sequence = before.metadata!.lastSequence + 1;
      const reservation = Object.freeze({
        providerKey: provider,
        sequence,
        reservedAtMs,
        measurementStartedNs,
      });
      const expected: QuotaHistory = {
        metadata: { ...before.metadata!, lastSequence: sequence },
        consumptions: [...before.consumptions, { sequence, reservedAtMs }],
      };
      attempt = {
        owner: this,
        trial,
        before: JSON.stringify(before),
        expected: JSON.stringify(expected),
        reservation,
      };
      this.pending.set(provider, attempt);
      this.db
        .prepare(
          "INSERT INTO provider_quota_consumptions (provider_key,sequence,reserved_at_ms) VALUES (?,?,?)",
        )
        .run(provider, sequence, reservedAtMs);
      const update = this.db
        .prepare(
          "UPDATE provider_quota_metadata SET last_sequence=? WHERE provider_key=? AND last_sequence=?",
        )
        .run(sequence, provider, sequence - 1);
      if (update.changes !== 1) throw new InvalidQuotaRows();
      attempt.guard = this.writeGuard();
      committing = true;
      this.db.exec("COMMIT");
      if (!this.resolved()) return this.unresolved();
      this.pending.delete(provider);
      return this.saved(attempt, false);
    } catch (error) {
      if (!this.resolveTransaction()) return this.unresolved();
      const problem =
        error instanceof InvalidQuotaRows
          ? { outcome: "quota_blocked" as const, reason: "invalid_quota_rows" }
          : this.problem(error);
      if (attempt && !committing) {
        this.pending.delete(attempt.trial.providerKey);
        return {
          outcome: "not_saved",
          scope: problem.outcome === "not_saved" ? problem.scope : "provider",
          reason: problem.reason,
        };
      }
      return attempt ? this.compare(attempt) : problem;
    } finally {
      this.coordination.busy = false;
    }
  }
  reconcile(providerKey: QuotaProvider): QuotaReservationResult {
    if (providerKey !== TOMORROW_IO)
      return {
        outcome: "not_saved",
        scope: "input",
        reason: "unsupported_provider",
      };
    const blocked = this.refusal();
    if (blocked)
      return blocked.outcome === "not_saved"
        ? { outcome: "unknown", scope: "database", reason: blocked.reason }
        : blocked;
    const pending = this.pending.get(providerKey);
    if (!pending || pending.owner !== this)
      return {
        outcome: "not_saved",
        scope: "provider",
        reason: "no_owned_pending_attempt",
      };
    this.coordination.busy = true;
    try {
      return this.compare(pending);
    } finally {
      this.coordination.busy = false;
    }
  }
  private compare(attempt: Pending): QuotaReservationResult {
    const unknown = (reason: string): QuotaReservationResult => ({
      outcome: "unknown",
      scope: "provider",
      reason,
    });
    try {
      if (!this.resolved()) return this.unresolved();
      this.db.exec("BEGIN");
      validateSchema(this.db);
      const actual = this.history(attempt.trial.providerKey);
      const guard = this.writeGuard();
      this.db.exec("COMMIT");
      if (!this.resolved()) return this.unresolved();
      if (
        !attempt.guard ||
        guard.changes !== attempt.guard.changes ||
        guard.version !== attempt.guard.version
      )
        return unknown("quota_writer_not_excluded");
      const json = JSON.stringify(actual);
      if (attempt.before === attempt.expected)
        return unknown("indistinguishable_quota_images");
      if (json === attempt.expected) {
        this.pending.delete(attempt.trial.providerKey);
        return this.saved(attempt, true);
      }
      if (json === attempt.before) {
        this.pending.delete(attempt.trial.providerKey);
        return {
          outcome: "not_saved",
          scope: "provider",
          reason: "reservation_not_saved",
        };
      }
      return unknown("unexpected_quota_history");
    } catch (error) {
      if (!this.resolveTransaction()) return this.unresolved();
      if (error instanceof InvalidQuotaRows)
        return unknown("quota_reconciliation_failed");
      const problem = this.problem(error);
      return {
        outcome: "unknown",
        scope: problem.scope,
        reason: "quota_reconciliation_failed",
      };
    }
  }
  private saved(attempt: Pending, reconciled: boolean): QuotaReservationResult {
    const evidence = opaque<QuotaReservationEvidence>();
    evidenceRegistry.set(evidence, {
      trial: attempt.trial,
      reservation: attempt.reservation,
    });
    return { outcome: "saved", evidence, reconciled };
  }
  private history(provider: string): QuotaHistory {
    const raw = this.db
      .prepare(
        "SELECT provider_key,history_status,initialized_at_ms,last_sequence FROM provider_quota_metadata WHERE provider_key=?",
      )
      .safeIntegers(true)
      .get(provider) as Record<string, unknown> | undefined;
    let metadata: QuotaMetadata | null = null;
    if (raw) {
      if (
        raw.provider_key !== provider ||
        (raw.history_status !== "ACTIVE" && raw.history_status !== "SUSPENDED")
      )
        throw new InvalidQuotaRows();
      metadata = {
        providerKey: provider,
        historyStatus: raw.history_status,
        initializedAtMs: integer(raw.initialized_at_ms),
        lastSequence: integer(raw.last_sequence),
      };
    }
    const rows = this.db
      .prepare(
        "SELECT sequence,reserved_at_ms FROM provider_quota_consumptions WHERE provider_key=? ORDER BY sequence",
      )
      .safeIntegers(true)
      .all(provider) as Record<string, unknown>[];
    const consumptions: QuotaConsumption[] = rows.map((row) => ({
      sequence: integer(row.sequence),
      reservedAtMs: integer(row.reserved_at_ms),
    }));
    return { metadata, consumptions };
  }
  private trust(source: () => QuotaTrust): QuotaTrust {
    try {
      const facts = source();
      return {
        clockTrusted: facts.clockTrusted === true,
        historyTimestampsTrusted: facts.historyTimestampsTrusted === true,
        historyComplete: facts.historyComplete === true,
      };
    } catch {
      return untrusted;
    }
  }
  private trustFailure(trust: QuotaTrust): string | undefined {
    if (!trust.clockTrusted) return "clock_untrusted";
    if (!trust.historyTimestampsTrusted) return "history_timestamps_untrusted";
    if (!trust.historyComplete) return "history_incomplete";
  }
  private writeGuard(): WriteGuard {
    const row = this.db
      .prepare("SELECT total_changes() AS n")
      .safeIntegers(true)
      .get() as { n: bigint };
    const version = this.db.pragma("data_version", { simple: true });
    if (
      typeof row.n !== "bigint" ||
      row.n < 0n ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version)
    )
      throw new Error("Unconfirmed write guard");
    return { changes: row.n, version };
  }
  private refusal(
    provider?: string,
  ):
    | Exclude<QuotaReservationResult, { outcome: "saved" | "quota_blocked" }>
    | undefined {
    if (this.coordination.connectionUnresolved) return this.unresolved();
    if (this.coordination.busy)
      return {
        outcome: "not_saved",
        scope: "database",
        reason: "connection_busy",
      };
    if (this.coordination.blocked)
      return {
        outcome: "not_saved",
        scope: "database",
        reason: this.coordination.blocked.reason,
      };
    if (provider && this.provisioningUnresolved.has(provider))
      return {
        outcome: "unknown",
        scope: "provider",
        reason: "provisioning_unconfirmed",
      };
    if (provider && this.pending.has(provider))
      return {
        outcome: "unknown",
        scope: "provider",
        reason: "commit_result_unknown",
      };
  }
  private problem(error: unknown): {
    outcome: "not_saved";
    scope: "provider" | "database";
    reason: string;
  } {
    const code = (error as { code?: string })?.code;
    if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT"))
      return {
        outcome: "not_saved",
        scope: "provider",
        reason: "quota_write_constraint",
      };
    try {
      const s = classifyDatabaseError(error);
      if (s.layer === "L3")
        this.coordination.blocked = {
          scope: "database",
          layer: s.layer,
          reason: s.reason,
        };
      return { outcome: "not_saved", scope: "database", reason: s.reason };
    } catch {
      this.coordination.blocked = {
        scope: "database",
        layer: "L4",
        reason: "storage_failure",
      };
      return {
        outcome: "not_saved",
        scope: "database",
        reason: "storage_failure",
      };
    }
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
      /* Check actual status, not the notification alone. */
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
}
