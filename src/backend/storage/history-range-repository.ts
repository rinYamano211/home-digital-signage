import type Database from "better-sqlite3";
import { connectionCoordination } from "./connection-coordination.js";
import { classifyDatabaseError, SchemaError } from "./errors.js";
import { validateSchema } from "./schema.js";
import { RuntimeHistory } from "../quota/internal/runtime-history.js";
import {
  evaluateHistoryFacts,
  type ConfirmedRangeFacts,
} from "../quota/history-evaluation.js";
import {
  inspectDrainEvidence,
  type DrainBoundaryEvidence,
} from "../quota/internal/history-boundaries.js";
import { boundaryJson, committedStartup } from "./internal/startup-commit.js";
interface Candidate {
  readonly rangeId: number;
  readonly startSequence: number;
  readonly endSequence: number;
}
declare const rangeBrand: unique symbol;
export interface ConfirmedRangeEvidence {
  readonly [rangeBrand]: true;
}
const evidence = new WeakMap<
  ConfirmedRangeEvidence,
  { db: Database.Database; range: Readonly<ConfirmedRangeFacts> }
>();
export function inspectConfirmedRange(
  proof: ConfirmedRangeEvidence,
): Readonly<ConfirmedRangeFacts> | null {
  const r = evidence.get(proof);
  if (
    !r ||
    !r.db.open ||
    connectionCoordination(r.db).blocked ||
    connectionCoordination(r.db).connectionUnresolved
  )
    return null;
  const context = committedStartup(r.db);
  return context &&
    context.scope.generation === r.range.generation &&
    context.scope.processInstanceId === r.range.processInstanceId
    ? r.range
    : null;
}
/** read confirms Range retrieval only, not complete History classification,
 * History/Quota Trust, or permission to send. It carries no confirmation token.
 */
export type RangeResult =
  | { outcome: "read"; ranges: readonly ConfirmedRangeFacts[] }
  | { outcome: "saved"; evidence: ConfirmedRangeEvidence }
  | { outcome: "rejected"; reason: string }
  | { outcome: "unknown"; reason: string }
  | {
      outcome: "database_error";
      layer: "L1" | "L2" | "L3" | "L4";
      reason: string;
    };
const integer = (n: unknown): number => {
  if (typeof n !== "bigint" || n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new SchemaError();
  return Number(n);
};
const natural = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
class Rejected extends Error {
  constructor(readonly reason: string) {
    super("Range rejected");
  }
}
/** Borrowed Connection only. Production Drain port has no issuer in 4B-2, so
 * INSERT is unreachable in production; tests mock that internal trust boundary.
 */
export class HistoryRangeRepository {
  private readonly c;
  constructor(
    private readonly db: Database.Database,
    private readonly runtime: RuntimeHistory,
  ) {
    this.c = connectionCoordination(db);
  }
  /** Unclassified consumption can remain; callers must not infer Trust here. */
  read(): RangeResult {
    return this.run();
  }
  insert(candidate: Candidate, drain: DrainBoundaryEvidence): RangeResult {
    try {
      if (!candidate || typeof candidate !== "object")
        return { outcome: "rejected", reason: "invalid_range_input" };
      return this.run(
        {
          rangeId: candidate.rangeId,
          startSequence: candidate.startSequence,
          endSequence: candidate.endSequence,
        },
        drain,
      );
    } catch {
      return { outcome: "rejected", reason: "invalid_range_input" };
    }
  }
  private run(
    candidate?: Candidate,
    drain?: DrainBoundaryEvidence,
  ): RangeResult {
    const c = this.c;
    if (c.connectionUnresolved)
      return this.fail("L4", "transaction_unresolved");
    if (c.blocked) return this.fail(c.blocked.layer ?? "L4", c.blocked.reason);
    if (c.busy)
      return {
        outcome: "database_error",
        layer: "L1",
        reason: "connection_busy",
      };
    let scope;
    try {
      scope = this.runtime.scope();
    } catch {
      return { outcome: "rejected", reason: "startup_unverified" };
    }
    if (!scope || !this.runtime.belongsToConnection(this.db))
      return { outcome: "rejected", reason: "startup_unverified" };
    const proof = candidate && drain ? inspectDrainEvidence(drain) : null;
    if (candidate) {
      if (
        !proof ||
        !this.runtime.isFrozen() ||
        proof.providerKey !== scope.providerKey ||
        proof.generation !== scope.generation ||
        proof.processInstanceId !== scope.processInstanceId ||
        proof.cutoffSequence !== scope.cutoffSequence ||
        proof.startSequence !== candidate.startSequence ||
        proof.endSequence !== candidate.endSequence
      )
        return { outcome: "rejected", reason: "drain_unverified" };
    }
    c.busy = true;
    let committing = false;
    try {
      if (this.db.inTransaction !== false) return this.unresolved();
      this.db.exec(candidate ? "BEGIN IMMEDIATE" : "BEGIN");
      validateSchema(this.db, 3);
      if (!this.runtime.scope()) throw new Rejected("startup_boundary_changed");
      // Reject unknown/NULL provider rows rather than silently filtering them.
      for (const table of [
        "provider_quota_metadata",
        "provider_quota_consumptions",
        "startup_provider_boundaries",
      ]) {
        const keys = this.db
          .prepare(`SELECT DISTINCT provider_key FROM ${table}`)
          .all() as { provider_key: unknown }[];
        if (keys.some((r) => r.provider_key !== scope.providerKey))
          throw new Rejected("provider_set_mismatch");
      }
      const history = this.runtime.historyWithinTransaction();
      const rows = this.db
        .prepare(
          "SELECT range_id,start_sequence,end_sequence FROM history_uncertain_ranges WHERE generation=? AND provider_key=? ORDER BY range_id ASC",
        )
        .safeIntegers(true)
        .all(scope.generation, scope.providerKey) as Record<string, unknown>[];
      const ranges: ConfirmedRangeFacts[] = rows.map((r) => ({
        ...scope,
        rangeId: integer(r.range_id),
        startSequence: integer(r.start_sequence),
        endSequence: integer(r.end_sequence),
        committed: true,
      }));
      const cutoff = this.runtime.effectiveCutoff();
      if (candidate) {
        if (
          !natural(candidate.rangeId) ||
          !natural(candidate.startSequence) ||
          !natural(candidate.endSequence) ||
          candidate.rangeId <= (ranges.at(-1)?.rangeId ?? 0) ||
          cutoff === null ||
          candidate.startSequence <= cutoff ||
          candidate.startSequence > candidate.endSequence ||
          candidate.endSequence > (history.metadata?.lastSequence ?? -1) ||
          proof?.lastSequence !== history.metadata?.lastSequence
        )
          throw new Rejected("invalid_range_candidate");
        ranges.push({ ...scope, ...candidate, committed: true });
      }
      const complete =
        !!history.metadata &&
        history.metadata.providerKey === scope.providerKey &&
        history.metadata.lastSequence === history.consumptions.length &&
        history.consumptions.every((r, i) => r.sequence === i + 1);
      const assessment = evaluateHistoryFacts({
        scope,
        boundary: {
          ...scope,
          startupOutcome: "committed",
          providerState:
            scope.cutoffSequence === null ? "UNPROVISIONED" : "PROVISIONED",
        },
        history,
        historyComplete: complete,
        valid: this.runtime.facts(),
        ranges,
        ...(scope.cutoffSequence === null && cutoff === 0
          ? {
              runtimeProvisioning: {
                ...scope,
                cutoffSequence: 0 as const,
                committed: true,
              },
            }
          : {}),
      });
      // Reads must expose existing Ranges while unclassified consumption awaits
      // Drain/Range registration. Only classification_gap is tolerated for read;
      // INSERT still requires complete classification and confirmed boundaries.
      if (
        assessment.evaluation === "BLOCKED" &&
        (candidate || assessment.reason !== "classification_gap")
      )
        throw new Rejected(assessment.reason);
      if (candidate) {
        const changed = this.db
          .prepare(
            "INSERT INTO history_uncertain_ranges (provider_key,generation,range_id,start_sequence,end_sequence) VALUES (?,?,?,?,?)",
          )
          .run(
            scope.providerKey,
            scope.generation,
            candidate.rangeId,
            candidate.startSequence,
            candidate.endSequence,
          );
        if (changed.changes !== 1) throw new SchemaError();
        const actual = this.db
          .prepare(
            "SELECT range_id,start_sequence,end_sequence FROM history_uncertain_ranges WHERE provider_key=? AND generation=? ORDER BY range_id ASC",
          )
          .safeIntegers(true)
          .all(scope.providerKey, scope.generation);
        const expected = ranges.map((r) => ({
          range_id: BigInt(r.rangeId),
          start_sequence: BigInt(r.startSequence),
          end_sequence: BigInt(r.endSequence),
        }));
        if (boundaryJson(actual) !== boundaryJson(expected))
          throw new SchemaError();
      }
      committing = true;
      this.db.exec("COMMIT");
      if (this.db.inTransaction !== false) return this.unresolved();
      if (!candidate)
        return {
          outcome: "read",
          ranges: Object.freeze(ranges.map((r) => Object.freeze(r))),
        };
      const token = Object.freeze(
        Object.create(null),
      ) as ConfirmedRangeEvidence;
      evidence.set(token, {
        db: this.db,
        range: Object.freeze({ ...scope, ...candidate, committed: true }),
      });
      return { outcome: "saved", evidence: token };
    } catch (error) {
      const original =
        error instanceof Rejected
          ? { outcome: "rejected" as const, reason: error.reason }
          : this.problem(error);
      let cleanupFailure:
        Extract<RangeResult, { outcome: "database_error" }> | undefined;
      try {
        const active = this.db.inTransaction;
        if (active !== true && active !== false) return this.unresolved();
        if (active) {
          try {
            this.db.exec("ROLLBACK");
          } catch (cleanup) {
            cleanupFailure = this.problem(cleanup);
          }
        }
        if (this.db.inTransaction !== false) return this.unresolved();
      } catch {
        return this.unresolved();
      }
      if (cleanupFailure) {
        if (cleanupFailure.layer === "L1" || cleanupFailure.layer === "L2")
          this.fail("L4", "rollback_failed");
        if (!committing)
          return this.fail(
            this.c.blocked?.layer ?? "L4",
            this.c.blocked?.reason ?? "rollback_failed",
          );
      }
      if (committing && candidate) {
        this.fail("L4", "range_commit_unknown");
        return { outcome: "unknown", reason: "range_commit_unknown" };
      }
      return original;
    } finally {
      c.busy = false;
    }
  }
  private problem(
    e: unknown,
  ): Extract<RangeResult, { outcome: "database_error" }> {
    try {
      const s = classifyDatabaseError(e);
      return this.fail(s.layer, s.reason);
    } catch {
      return this.fail("L4", "storage_failure");
    }
  }
  private unresolved(): Extract<RangeResult, { outcome: "database_error" }> {
    this.c.connectionUnresolved = true;
    return this.fail("L4", "transaction_unresolved");
  }
  private fail(
    layer: "L1" | "L2" | "L3" | "L4",
    reason: string,
  ): Extract<RangeResult, { outcome: "database_error" }> {
    if (layer === "L3" || layer === "L4")
      this.c.blocked = { scope: "database", layer, reason };
    return { outcome: "database_error", layer, reason };
  }
}
