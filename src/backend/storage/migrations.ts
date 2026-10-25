import type Database from "better-sqlite3";
import { SchemaError } from "./errors.js";
import { validateSchema } from "./schema.js";

export interface Migration {
  from: number;
  to: number;
  validateBefore(db: Database.Database): void;
  validateAfter(db: Database.Database): void;
  apply(db: Database.Database): void;
}
// No production upgrade exists yet. Version 0 is not an initialization route.
export const MIGRATIONS: readonly Migration[] = Object.freeze([]);
export function migrate(
  db: Database.Database,
  allowed: readonly Migration[] = MIGRATIONS,
  target = 1,
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
    } catch (error) {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
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
  if (target === 1) validateSchema(db);
}
