import type Database from "better-sqlite3";
import type { ExclusiveLock } from "./lock.js";
import { normalizedBootId, readOsBootId } from "../time/boot-id.js";
import {
  TOMORROW_IO,
  type QuotaProvider,
  type QuotaHistory,
} from "../quota/quota-guard.js";
import { historyFingerprint } from "../quota/history-fingerprint.js";
import { connectionCoordination } from "./connection-coordination.js";
import { classifyDatabaseError, SchemaError } from "./errors.js";
import {
  validateSchema,
  validateLifecycleMarker,
  type LifecycleMarker,
} from "./schema.js";
import { HistoryFingerprintRepository } from "./history-fingerprint-repository.js";

export const STARTUP_PROVIDERS: readonly QuotaProvider[] = Object.freeze([
  TOMORROW_IO,
]);
export interface StartupRequest {
  bootId: string;
}
export type StartupResult =
  | { outcome: "committed"; generation: number }
  | { outcome: "rejected"; reason: string }
  | {
      outcome: "database_error";
      layer: "L1" | "L2" | "L3" | "L4";
      reason: string;
    }
  | { outcome: "unknown"; reason: string };
class StartupRejection extends Error {
  constructor(readonly reason: string) {
    super("Startup rejected");
  }
}
type Row = Record<string, unknown>;
const attempted = new WeakSet<Database.Database>();
const reject = (reason: string): never => {
  throw new StartupRejection(reason);
};
function integer(value: unknown): number {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  )
    return reject("invalid_history_integer");
  return Number(value);
}
function boot(value: unknown): string {
  if (typeof value !== "string" || normalizedBootId(value) !== value)
    return reject("invalid_boot_id");
  return value;
}
function state(value: unknown): "RUNNING" | "CLEAN" {
  if (value !== "RUNNING" && value !== "CLEAN")
    return reject("invalid_previous_state");
  return value;
}
/** Internal owner of a single Startup attempt. Only the restricted Store facade
 * wires this to its locked v3 Connection; no Quota/HTTP capabilities are exposed.
 * No Trust, Recovery approval or send authority is produced by this service.
 */
export class StartupTransactionService {
  private readonly c;
  constructor(
    private readonly db: Database.Database,
    private readonly lock: ExclusiveLock,
  ) {
    this.c = connectionCoordination(db);
  }
  execute(request: StartupRequest): StartupResult {
    const c = this.c;
    if (attempted.has(this.db))
      return { outcome: "rejected", reason: "startup_already_attempted" };
    if (c.connectionUnresolved) return this.unresolved();
    if (c.blocked)
      return {
        outcome: "database_error",
        layer: c.blocked.layer ?? "L4",
        reason: c.blocked.reason,
      };
    if (c.busy)
      return {
        outcome: "database_error",
        layer: "L1",
        reason: "connection_busy",
      };
    // A caller cannot restart a failed/unknown Startup by constructing a new
    // service on the same Connection. Contention before ownership is not an attempt.
    attempted.add(this.db);
    c.busy = true;
    let began = false;
    let beginAttempted = false;
    let committing = false;
    try {
      this.lock.assertHeld();
      if (!this.db.open) return this.failure("L2", "database_unavailable");
      if (this.transactionActive() !== false) return this.unresolved();
      const id = normalizedBootId(request?.bootId);
      if (id === null || id !== readOsBootId())
        return reject("os_boot_id_unverified");
      this.settings();
      // Preflight is not evidence: repeat validation under BEGIN IMMEDIATE.
      validateSchema(this.db, 3);
      const before = validateLifecycleMarker(this.db);
      if (before.generation === Number.MAX_SAFE_INTEGER)
        return reject("generation_exhausted");
      this.parents(before);
      this.histories();
      beginAttempted = true;
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      this.lock.assertHeld();
      this.settings();
      validateSchema(this.db, 3);
      const previous = validateLifecycleMarker(this.db);
      this.parents(previous);
      const histories = this.histories();
      if (previous.generation === Number.MAX_SAFE_INTEGER)
        return reject("generation_exhausted");
      if (previous.generation >= 2) {
        const verifier = new HistoryFingerprintRepository(this.db);
        for (const provider of STARTUP_PROVIDERS) {
          const result = verifier.verifyLatestWithinTransaction(provider);
          if (result.outcome === "database_error")
            throw new DatabaseFailure(result.layer, result.reason);
          if (result.outcome !== "matched") return reject(result.reason);
          const metadata = histories.get(provider)!.metadata;
          if (
            result.cutoffSequence !== null &&
            (!metadata || metadata.lastSequence < result.cutoffSequence)
          )
            return reject("history_regressed");
        }
      }
      const generation = previous.generation + 1;
      const snapshots = STARTUP_PROVIDERS.map((provider) => {
        const history = histories.get(provider)!;
        return { provider, history, fingerprint: historyFingerprint(history) };
      });
      this.db
        .prepare(
          "INSERT INTO startup_generations (generation,boot_id,previous_state,previous_boot_id,previous_generation) VALUES (?,?,?,?,?)",
        )
        .run(
          generation,
          id,
          previous.state,
          previous.bootId,
          previous.generation,
        );
      for (const s of snapshots) {
        const m = s.history.metadata;
        this.db
          .prepare(
            "INSERT INTO startup_provider_boundaries (generation,provider_key,provider_state,cutoff_sequence,history_status_snapshot,initialized_at_ms_snapshot,history_fingerprint) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            generation,
            s.provider,
            m ? "PROVISIONED" : "UNPROVISIONED",
            m?.lastSequence ?? null,
            m?.historyStatus ?? null,
            m?.initializedAtMs ?? null,
            s.fingerprint,
          );
      }
      const saved = this.rows(
        "SELECT provider_key,provider_state,cutoff_sequence,history_status_snapshot,initialized_at_ms_snapshot,history_fingerprint FROM startup_provider_boundaries WHERE generation=? ORDER BY provider_key",
        generation,
      );
      this.providerSet(saved, true);
      for (const s of snapshots) {
        const r = saved.find((row) => row.provider_key === s.provider)!;
        const m = s.history.metadata;
        if (
          r.provider_state !== (m ? "PROVISIONED" : "UNPROVISIONED") ||
          r.cutoff_sequence !== (m ? BigInt(m.lastSequence) : null) ||
          r.history_status_snapshot !== (m?.historyStatus ?? null) ||
          r.initialized_at_ms_snapshot !==
            (m ? BigInt(m.initializedAtMs) : null) ||
          r.history_fingerprint !== s.fingerprint
        )
          return reject("boundary_insert_mismatch");
      }
      const updated = this.db
        .prepare(
          "UPDATE backend_lifecycle SET state='RUNNING',boot_id=?,generation=? WHERE lifecycle_key=1 AND state=? AND boot_id=? AND generation=?",
        )
        .run(
          id,
          generation,
          previous.state,
          previous.bootId,
          previous.generation,
        );
      if (updated.changes !== 1) return reject("lifecycle_update_mismatch");
      const marker = validateLifecycleMarker(this.db);
      if (
        marker.state !== "RUNNING" ||
        marker.bootId !== id ||
        marker.generation !== generation
      )
        return reject("lifecycle_update_mismatch");
      if (this.transactionActive() !== true) return this.unresolved();
      committing = true;
      this.db.exec("COMMIT");
      if (this.transactionActive() !== false) return this.unresolved();
      return { outcome: "committed", generation };
    } catch (error) {
      let original: StartupResult =
        error instanceof StartupRejection
          ? { outcome: "rejected", reason: error.reason }
          : error instanceof DatabaseFailure
            ? this.failure(error.layer, error.reason)
            : this.classify(error);
      let active: boolean;
      try {
        active = this.transactionActive();
      } catch {
        return this.unresolved();
      }
      // BEGIN may have thrown after acquiring the Transaction. No pre-existing
      // Transaction was present when ownership was acquired.
      if (active) {
        if (!beginAttempted) return this.unresolved();
        try {
          this.db.exec("ROLLBACK");
        } catch (cleanup) {
          const failure = this.classify(cleanup);
          if (failure.layer === "L3" || failure.layer === "L4")
            original = failure;
          else original = this.failure("L4", "rollback_failed");
        }
        try {
          if (this.transactionActive() !== false) return this.unresolved();
        } catch {
          return this.unresolved();
        }
      } else if (began && !committing) {
        // Unexpected loss of the owned write Transaction is not confirmed rollback.
        this.failure("L4", "transaction_ended_unexpectedly");
        return { outcome: "unknown", reason: "startup_result_unknown" };
      }
      // Even a COMMIT-after-success throw with matching Rows is never adopted.
      if (committing)
        return { outcome: "unknown", reason: "startup_commit_unknown" };
      return original;
    } finally {
      c.busy = false;
    }
  }
  private transactionActive(): boolean {
    const active: unknown = this.db.inTransaction;
    if (active !== true && active !== false)
      throw new Error("Transaction status unavailable");
    return active;
  }
  private settings(): void {
    if (
      this.db.pragma("journal_mode", { simple: true }) !== "wal" ||
      this.db.pragma("synchronous", { simple: true }) !== 2 ||
      this.db.pragma("foreign_keys", { simple: true }) !== 1
    )
      throw new SchemaError();
  }
  private rows(sql: string, ...params: (number | string)[]): Row[] {
    return this.db
      .prepare(sql)
      .safeIntegers(true)
      .all(...params) as Row[];
  }
  private providerSet(rows: Row[], exact = false): void {
    const keys = rows.map((r) => r.provider_key);
    if (
      new Set(keys).size !== keys.length ||
      keys.some(
        (k) => typeof k !== "string" || !STARTUP_PROVIDERS.some((p) => p === k),
      ) ||
      (exact && keys.length !== STARTUP_PROVIDERS.length)
    )
      return reject("provider_set_mismatch");
  }
  private parents(marker: LifecycleMarker): void {
    const parents = this.rows(
      "SELECT generation,boot_id,previous_state,previous_boot_id,previous_generation FROM startup_generations ORDER BY generation ASC",
    );
    const boundaries = this.rows(
      "SELECT generation,provider_key FROM startup_provider_boundaries ORDER BY generation,provider_key",
    );
    if (parents.length !== marker.generation - 1)
      return reject("startup_chain_mismatch");
    let previousBoot: string | undefined;
    for (let i = 0; i < parents.length; i++) {
      const row = parents[i];
      if (
        integer(row.generation) !== i + 2 ||
        integer(row.previous_generation) !== i + 1
      )
        return reject("startup_chain_mismatch");
      const currentBoot = boot(row.boot_id);
      const oldBoot = boot(row.previous_boot_id);
      const oldState = state(row.previous_state);
      if (
        (i === 0 && oldState !== "RUNNING") ||
        (previousBoot !== undefined && oldBoot !== previousBoot)
      )
        return reject("startup_chain_mismatch");
      previousBoot = currentBoot;
    }
    if (marker.generation === 1) {
      if (marker.state !== "RUNNING" || boundaries.length !== 0)
        return reject("invalid_initial_generation");
    } else if (previousBoot !== marker.bootId)
      return reject("startup_chain_mismatch");
    if (boundaries.length !== parents.length * STARTUP_PROVIDERS.length)
      return reject("boundary_set_mismatch");
    const groups = new Map<number, Row[]>();
    for (const row of boundaries) {
      const gen = integer(row.generation);
      if (gen < 2 || gen > marker.generation)
        return reject("boundary_set_mismatch");
      const group = groups.get(gen) ?? [];
      group.push(row);
      groups.set(gen, group);
    }
    for (let gen = 2; gen <= marker.generation; gen++)
      this.providerSet(groups.get(gen) ?? [], true);
  }
  private histories(): Map<QuotaProvider, QuotaHistory> {
    const metadata = this.rows(
      "SELECT provider_key,history_status,initialized_at_ms,last_sequence FROM provider_quota_metadata ORDER BY provider_key",
    );
    this.providerSet(metadata);
    const rows = this.rows(
      "SELECT provider_key,sequence,reserved_at_ms FROM provider_quota_consumptions ORDER BY provider_key,sequence ASC",
    );
    if (rows.some((r) => !STARTUP_PROVIDERS.some((p) => p === r.provider_key)))
      return reject("provider_set_mismatch");
    const histories = new Map<QuotaProvider, QuotaHistory>();
    for (const provider of STARTUP_PROVIDERS) {
      const m = metadata.find((r) => r.provider_key === provider);
      const consumption = rows.filter((r) => r.provider_key === provider);
      if (!m && consumption.length) return reject("metadata_missing");
      if (
        m &&
        m.history_status !== "ACTIVE" &&
        m.history_status !== "SUSPENDED"
      )
        return reject("invalid_metadata");
      const history: QuotaHistory = {
        metadata: m
          ? {
              providerKey: provider,
              historyStatus: m.history_status as "ACTIVE" | "SUSPENDED",
              initializedAtMs: integer(m.initialized_at_ms),
              lastSequence: integer(m.last_sequence),
            }
          : null,
        consumptions: consumption.map((r) => ({
          sequence: integer(r.sequence),
          reservedAtMs: integer(r.reserved_at_ms),
        })),
      };
      try {
        historyFingerprint(history);
      } catch {
        return reject("invalid_history");
      }
      histories.set(provider, history);
    }
    return histories;
  }
  private classify(
    error: unknown,
  ): Extract<StartupResult, { outcome: "database_error" }> {
    try {
      const s = classifyDatabaseError(error);
      return this.failure(s.layer, s.reason);
    } catch {
      return this.failure("L4", "storage_failure");
    }
  }
  private unresolved(): Extract<StartupResult, { outcome: "database_error" }> {
    this.c.connectionUnresolved = true;
    return this.failure("L4", "transaction_unresolved");
  }
  private failure(
    layer: "L1" | "L2" | "L3" | "L4",
    reason: string,
  ): Extract<StartupResult, { outcome: "database_error" }> {
    if (layer === "L3" || layer === "L4")
      this.c.blocked = { scope: "database", layer, reason };
    return { outcome: "database_error", layer, reason };
  }
}
class DatabaseFailure extends Error {
  constructor(
    readonly layer: "L1" | "L2" | "L3" | "L4",
    readonly reason: string,
  ) {
    super("Startup database failure");
  }
}
