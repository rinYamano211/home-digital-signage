import type Database from "better-sqlite3";
import { connectionCoordination } from "./connection-coordination.js";
import { classifyDatabaseError, SchemaError } from "./errors.js";
import {
  validateSchema,
  validateLifecycleMarker,
  type LifecycleMarker,
} from "./schema.js";
export type { LifecycleMarker } from "./schema.js";
export type LifecycleReadResult =
  | { outcome: "found"; marker: LifecycleMarker }
  | {
      outcome: "database_error";
      layer: "L1" | "L2" | "L3" | "L4";
      reason: string;
    };

/** Borrows the Store Connection. No write, close, Startup success or send API. */
export class LifecycleRepository {
  private readonly coordination;
  constructor(private readonly db: Database.Database) {
    this.coordination = connectionCoordination(db);
  }
  read(): LifecycleReadResult {
    const c = this.coordination;
    if (c.connectionUnresolved) return this.unresolved();
    if (c.busy) return this.problem("L1", "connection_busy");
    if (c.blocked)
      return {
        outcome: "database_error",
        layer: c.blocked.layer ?? "L4",
        reason: c.blocked.reason,
      };
    try {
      if (!this.db.open) return this.problem("L2", "database_unavailable");
    } catch {
      return this.problem("L4", "storage_failure");
    }
    c.busy = true;
    try {
      // Do not enter or roll back an unowned existing Transaction.
      if (this.db.inTransaction !== false) return this.unresolved();
      try {
        this.db.exec("BEGIN");
        const marker = this.readWithinTransaction();
        this.db.exec("COMMIT");
        if (this.db.inTransaction !== false) return this.unresolved();
        return { outcome: "found", marker };
      } catch (error) {
        const resolution = this.resolveRead();
        if (!resolution.ended) return this.unresolved();
        // An ended read Transaction is not proof of Connection health. Apply
        // existing fatal-error rules to BOTH the original and cleanup errors.
        const original = this.classifyFailure(error);
        const rollback = resolution.rollbackFailure;
        const failure =
          original.layer === "L3" || original.layer === "L4"
            ? original
            : rollback && (rollback.layer === "L3" || rollback.layer === "L4")
              ? rollback
              : original;
        // Even COMMIT-after-success exceptions do not publish the cached Row.
        // Any later caller must start a new read and revalidate Schema/Marker.
        return this.problem(failure.layer, failure.reason);
      }
    } catch {
      return this.unresolved();
    } finally {
      c.busy = false;
    }
  }
  /** Internal boundary for the future owner of the single Startup Transaction.
   * Caller owns busy + Transaction. Never BEGIN/COMMIT/UPDATE or return evidence.
   * The limited Store facade does not expose this method.
   */
  readWithinTransaction(): LifecycleMarker {
    const c = this.coordination;
    if (
      !this.db.open ||
      !c.busy ||
      c.blocked ||
      c.connectionUnresolved ||
      this.db.inTransaction !== true
    )
      throw new SchemaError();
    validateSchema(this.db, 3);
    return validateLifecycleMarker(this.db);
  }
  private classifyFailure(
    error: unknown,
  ): Extract<LifecycleReadResult, { outcome: "database_error" }> {
    try {
      const status = classifyDatabaseError(error);
      return {
        outcome: "database_error",
        layer: status.layer,
        reason: status.reason,
      };
    } catch {
      return {
        outcome: "database_error",
        layer: "L4",
        reason: "storage_failure",
      };
    }
  }
  private resolveRead(): {
    ended: boolean;
    rollbackFailure?: Extract<
      LifecycleReadResult,
      { outcome: "database_error" }
    >;
  } {
    try {
      if (this.db.inTransaction === false) return { ended: true };
      if (this.db.inTransaction !== true) return { ended: false };
    } catch {
      return { ended: false };
    }
    let rollbackFailure:
      Extract<LifecycleReadResult, { outcome: "database_error" }> | undefined;
    try {
      this.db.exec("ROLLBACK");
    } catch (error) {
      rollbackFailure = this.classifyFailure(error);
    }
    try {
      return { ended: this.transactionResolved(), rollbackFailure };
    } catch {
      return { ended: false, rollbackFailure };
    }
  }
  private transactionResolved(): boolean {
    return this.db.inTransaction === false;
  }
  private unresolved(): LifecycleReadResult {
    this.coordination.connectionUnresolved = true;
    return this.problem("L4", "transaction_unresolved");
  }
  private problem(
    layer: "L1" | "L2" | "L3" | "L4",
    reason: string,
  ): LifecycleReadResult {
    if (layer === "L3" || layer === "L4")
      this.coordination.blocked = { scope: "database", layer, reason };
    return { outcome: "database_error", layer, reason };
  }
}
