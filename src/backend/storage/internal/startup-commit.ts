import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { validateLifecycleMarker } from "../schema.js";
import { connectionCoordination } from "../connection-coordination.js";
import type { HistoryScope } from "../../quota/history-evaluation.js";
const processInstanceId = randomUUID();
export interface CommittedStartup {
  readonly scope: HistoryScope;
  readonly bootId: string;
  readonly boundaryJson: string;
}
const commits = new WeakMap<Database.Database, CommittedStartup>();
/** Issuer boundary: called only by StartupTransactionService AFTER confirmed Commit. */
export function recordStartupCommit(
  db: Database.Database,
  generation: number,
  bootId: string,
): void {
  const rows = db
    .prepare(
      "SELECT * FROM startup_provider_boundaries WHERE generation=? ORDER BY provider_key",
    )
    .safeIntegers(true)
    .all(generation) as Record<string, unknown>[];
  if (rows.length !== 1 || rows[0].provider_key !== "tomorrow.io")
    throw Error("Startup handoff failed");
  if (db.inTransaction !== false) throw Error("Startup handoff unresolved");
  const r = rows[0];
  const cutoff = r.cutoff_sequence === null ? null : Number(r.cutoff_sequence);
  commits.set(
    db,
    Object.freeze({
      scope: Object.freeze({
        providerKey: "tomorrow.io",
        generation,
        processInstanceId,
        cutoffSequence: cutoff,
      }),
      bootId,
      boundaryJson: JSON.stringify(r, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    }),
  );
}
export function committedStartup(
  db: Database.Database,
): CommittedStartup | null {
  const c = connectionCoordination(db);
  if (!db.open || c.blocked || c.connectionUnresolved) return null;
  const record = commits.get(db);
  if (!record) return null;
  try {
    const marker = validateLifecycleMarker(db);
    if (
      marker.state !== "RUNNING" ||
      marker.generation !== record.scope.generation ||
      marker.bootId !== record.bootId
    )
      return null;
    const boundary = db
      .prepare(
        "SELECT * FROM startup_provider_boundaries WHERE generation=? AND provider_key=?",
      )
      .safeIntegers(true)
      .get(record.scope.generation, record.scope.providerKey);
    return boundaryJson(boundary) === record.boundaryJson ? record : null;
  } catch {
    return null;
  }
}
export const boundaryJson = (r: unknown): string =>
  JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
