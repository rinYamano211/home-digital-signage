import type Database from "better-sqlite3";
import type { Migration } from "./migrations.js";
import { validateSchema } from "./schema.js";
import { LIFECYCLE_DDL } from "./lifecycle-ddl.js";
import { SchemaError } from "./errors.js";
import { readOsBootId } from "../time/boot-id.js";

export function assertV3Durability(db: Database.Database): void {
  if (
    db.pragma("journal_mode", { simple: true }) !== "wal" ||
    db.pragma("synchronous", { simple: true }) !== 2 ||
    db.pragma("foreign_keys", { simple: true }) !== 1
  )
    throw new SchemaError();
}
/** Explicit operation only: captures a verified OS ID once, before BEGIN.
 * Caller must hold the administrative EX lock. Never added to MIGRATIONS.
 */
export function v2ToV3Migration(): Migration {
  const bootId = readOsBootId();
  return Object.freeze({
    from: 2,
    to: 3,
    validateBefore(db: Database.Database) {
      validateSchema(db, 2);
      assertV3Durability(db);
    },
    apply(db: Database.Database) {
      assertV3Durability(db);
      db.exec(LIFECYCLE_DDL);
      db.prepare(
        "INSERT INTO backend_lifecycle (lifecycle_key,state,boot_id,generation) VALUES (1,'RUNNING',?,1)",
      ).run(bootId);
    },
    validateAfter(db: Database.Database) {
      validateSchema(db, 3);
      assertV3Durability(db);
      const marker = db
        .prepare(
          "SELECT state,boot_id,generation FROM backend_lifecycle WHERE lifecycle_key=1",
        )
        .safeIntegers(true)
        .get() as { state: unknown; boot_id: unknown; generation: unknown };
      if (
        marker.state !== "RUNNING" ||
        marker.boot_id !== bootId ||
        marker.generation !== 1n
      )
        throw new SchemaError();
      for (const name of [
        "startup_generations",
        "startup_provider_boundaries",
        "history_uncertain_ranges",
      ]) {
        const count = db
          .prepare(`SELECT count(*) AS n FROM ${name}`)
          .safeIntegers(true)
          .get() as { n: bigint };
        if (count.n !== 0n) throw new SchemaError();
      }
    },
  });
}
