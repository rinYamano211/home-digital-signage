import type Database from "better-sqlite3";
import { connectionCoordination } from "./connection-coordination.js";
import { classifyDatabaseError, SchemaError } from "./errors.js";
import { LifecycleRepository } from "./lifecycle-repository.js";
import {
  historyFingerprint,
  FingerprintInputError,
} from "../quota/history-fingerprint.js";
import { quotaTimestamp, type QuotaHistory } from "../quota/quota-guard.js";

export type FingerprintVerificationResult =
  | {
      outcome: "matched";
      providerKey: string;
      generation: number;
      cutoffSequence: number | null;
      fingerprint: string;
    }
  | {
      outcome: "rejected";
      reason:
        | "boundary_missing"
        | "invalid_boundary"
        | "invalid_history"
        | "fingerprint_mismatch";
    }
  | {
      outcome: "database_error";
      layer: "L1" | "L2" | "L3" | "L4";
      reason: string;
    };
function integer(value: unknown): number {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new FingerprintInputError();
  return Number(value);
}
/** Borrows the existing Store Connection. The future Startup owner owns busy,
 * BEGIN/COMMIT/ROLLBACK. No public facade, writes, Trust or send permission.
 */
export class HistoryFingerprintRepository {
  private readonly coordination;
  private readonly lifecycle;
  constructor(private readonly db: Database.Database) {
    this.coordination = connectionCoordination(db);
    this.lifecycle = new LifecycleRepository(db);
  }
  verifyLatestWithinTransaction(
    providerKey: string,
  ): FingerprintVerificationResult {
    if (typeof providerKey !== "string" || providerKey.length === 0)
      throw new TypeError("Invalid fingerprint provider");
    const c = this.coordination;
    if (c.connectionUnresolved)
      return this.failure("L4", "transaction_unresolved");
    if (c.blocked)
      return {
        outcome: "database_error",
        layer: c.blocked.layer ?? "L4",
        reason: c.blocked.reason,
      };
    if (!c.busy) throw new TypeError("Owned Transaction required");
    try {
      if (!this.db.open) return this.failure("L2", "database_unavailable");
      if (this.db.inTransaction !== true) throw new SchemaError();
      const marker = this.lifecycle.readWithinTransaction();
      // Select the newest Row without filtering by validity or cutoff. Require
      // its generation to equal Lifecycle: missing latest must not fall back.
      const row = this.db
        .prepare(
          "SELECT generation,provider_key,provider_state,cutoff_sequence,history_status_snapshot,initialized_at_ms_snapshot,history_fingerprint FROM startup_provider_boundaries WHERE provider_key=? ORDER BY generation DESC LIMIT 1",
        )
        .safeIntegers(true)
        .get(providerKey) as Record<string, unknown> | undefined;
      if (!row) return { outcome: "rejected", reason: "boundary_missing" };
      let generation: number,
        cutoff: number | null,
        fingerprint: string,
        history: QuotaHistory;
      try {
        generation = integer(row.generation);
        if (
          generation < 2 ||
          generation !== marker.generation ||
          row.provider_key !== providerKey ||
          typeof row.history_fingerprint !== "string" ||
          !/^[0-9a-f]{64}$/.test(row.history_fingerprint)
        )
          throw new FingerprintInputError();
        fingerprint = row.history_fingerprint;
        if (row.provider_state === "UNPROVISIONED") {
          if (
            row.cutoff_sequence !== null ||
            row.history_status_snapshot !== null ||
            row.initialized_at_ms_snapshot !== null
          )
            throw new FingerprintInputError();
          cutoff = null;
          history = { metadata: null, consumptions: [] };
        } else if (row.provider_state === "PROVISIONED") {
          cutoff = integer(row.cutoff_sequence);
          const initialized = integer(row.initialized_at_ms_snapshot);
          if (
            !quotaTimestamp(initialized) ||
            (row.history_status_snapshot !== "ACTIVE" &&
              row.history_status_snapshot !== "SUSPENDED")
          )
            throw new FingerprintInputError();
          history = {
            metadata: {
              providerKey,
              historyStatus: row.history_status_snapshot,
              initializedAtMs: initialized,
              lastSequence: cutoff,
            },
            consumptions: [],
          };
        } else throw new FingerprintInputError();
      } catch {
        return { outcome: "rejected", reason: "invalid_boundary" };
      }
      if (cutoff !== null) {
        const rows = this.db
          .prepare(
            "SELECT sequence,reserved_at_ms FROM provider_quota_consumptions WHERE provider_key=? AND sequence<=? ORDER BY sequence ASC",
          )
          .safeIntegers(true)
          .all(providerKey, cutoff) as {
          sequence: unknown;
          reserved_at_ms: unknown;
        }[];
        try {
          history = {
            ...history,
            consumptions: rows.map((r) => ({
              sequence: integer(r.sequence),
              reservedAtMs: integer(r.reserved_at_ms),
            })),
          };
        } catch {
          return { outcome: "rejected", reason: "invalid_history" };
        }
      }
      let actual: string;
      try {
        actual = historyFingerprint(history);
      } catch (error) {
        if (error instanceof FingerprintInputError)
          return { outcome: "rejected", reason: "invalid_history" };
        throw error;
      }
      if (actual !== fingerprint)
        return { outcome: "rejected", reason: "fingerprint_mismatch" };
      if (this.db.inTransaction !== true) throw new SchemaError();
      return {
        outcome: "matched",
        providerKey,
        generation,
        cutoffSequence: cutoff,
        fingerprint,
      };
    } catch (error) {
      // This reader never resolves its caller's Transaction or retries it.
      try {
        void this.db.inTransaction;
      } catch {
        c.connectionUnresolved = true;
        return this.failure("L4", "transaction_unresolved");
      }
      try {
        const status = classifyDatabaseError(error);
        return this.failure(status.layer, status.reason);
      } catch {
        return this.failure("L4", "storage_failure");
      }
    }
  }
  private failure(
    layer: "L1" | "L2" | "L3" | "L4",
    reason: string,
  ): FingerprintVerificationResult {
    if (layer === "L3" || layer === "L4")
      this.coordination.blocked = { scope: "database", layer, reason };
    return { outcome: "database_error", layer, reason };
  }
}
