import type Database from "better-sqlite3";
import { SchemaError } from "./errors.js";
import { validateSchema, QUOTA_DDL, enableForeignKeys } from "./schema.js";

export interface Migration {
  from: number;
  to: number;
  validateBefore(db: Database.Database): void;
  validateAfter(db: Database.Database): void;
  apply(db: Database.Database): void;
}
// Old Release rejects v2. Keep the automatic allowlist empty until compatibility
// is verified. Explicit administrative upgrade may select V1_TO_V2 under EX.
export const V1_TO_V2: Migration = Object.freeze({
  from: 1,
  to: 2,
  validateBefore(db: Database.Database) {
    validateSchema(db, 1);
  },
  validateAfter(db: Database.Database) {
    validateSchema(db, 2);
  },
  apply(db: Database.Database) {
    db.exec(QUOTA_DDL);
  },
});
export const MIGRATIONS: readonly Migration[] = Object.freeze([]);
export function migrate(
  db: Database.Database,
  allowed: readonly Migration[] = MIGRATIONS,
  target = 2,
) {
  try {
    if (db.inTransaction !== false) throw new SchemaError();
    if (target === 2) enableForeignKeys(db);
    applyMigrations(db, allowed, target);
  } catch (error) {
    // Definition/validator failures require manual review, not an OS-fatal exit.
    // Keep SQLite result codes so temporary and storage failures retain their layer.
    if (
      error instanceof SchemaError ||
      (typeof (error as { code?: unknown })?.code === "string" &&
        (error as { code: string }).code.startsWith("SQLITE_"))
    )
      throw error;
    throw new SchemaError();
  }
}
function applyMigrations(
  db: Database.Database,
  allowed: readonly Migration[],
  target: number,
) {
  const seen = new Set<number>();
  while (db.pragma("user_version", { simple: true }) !== target) {
    const version = Number(db.pragma("user_version", { simple: true }));
    const entry = allowed.find((item) => item.from === version);
    if (
      !entry ||
      version === 0 ||
      entry.to <= version ||
      entry.to > target ||
      seen.has(version)
    )
      throw new SchemaError();
    seen.add(version);
    entry.validateBefore(db);
    try {
      db.exec("BEGIN IMMEDIATE");
      entry.apply(db);
      db.pragma(`user_version = ${entry.to}`);
      entry.validateAfter(db);
      db.exec("COMMIT");
      if (db.inTransaction !== false) throw new SchemaError();
    } catch (error) {
      try {
        const active = db.inTransaction;
        if (active === true) db.exec("ROLLBACK");
        if (db.inTransaction !== false) throw new SchemaError();
      } catch {
        throw new SchemaError();
      }
      // Reconcile ambiguous commit; never blindly replay a migration.
      const actual = db.pragma("user_version", { simple: true });
      if (actual === entry.to) {
        entry.validateAfter(db);
        continue;
      }
      if (actual !== version) throw new SchemaError();
      entry.validateBefore(db);
      throw error;
    }
  }
  if (target === 1 || target === 2) validateSchema(db, target);
}
