import type Database from "better-sqlite3";
import { SchemaError } from "./errors.js";

export const INITIAL_DDL = String.raw`CREATE TABLE published_state_snapshots (
    state_key TEXT NOT NULL CHECK (length(state_key) > 0),
    generation INTEGER NOT NULL CHECK (generation > 0),
    snapshot_json TEXT NOT NULL,
    PRIMARY KEY (state_key, generation)
);

CREATE TABLE backend_cache (
    state_key TEXT PRIMARY KEY NOT NULL
        CHECK (length(state_key) > 0),
    cache_json TEXT NOT NULL
);

CREATE TABLE acquisition_control (
    state_key TEXT PRIMARY KEY NOT NULL
        CHECK (length(state_key) > 0),
    control_json TEXT NOT NULL
);

CREATE TABLE state_generation_counters (
    state_key TEXT PRIMARY KEY NOT NULL
        CHECK (length(state_key) > 0),
    last_generation INTEGER NOT NULL
        CHECK (last_generation >= 0)
);`;
const statements = INITIAL_DDL.split(";")
  .map((sql) => sql.trim())
  .filter(Boolean);
const normalize = (sql: string) =>
  sql.toLowerCase().replace(/\s+/g, "").replace(/;$/, "");
export function initializeSchema(db: Database.Database) {
  db.transaction(() => {
    db.exec(INITIAL_DDL);
    db.pragma("user_version = 1");
  })();
}
export function validateSchema(db: Database.Database) {
  if (db.pragma("user_version", { simple: true }) !== 1)
    throw new SchemaError();
  const rows = db
    .prepare(
      "SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all() as { name: string; type: string; sql: string }[];
  if (rows.length !== 4) throw new SchemaError();
  for (const statement of statements) {
    const name = /CREATE TABLE (\w+)/.exec(statement)![1];
    const row = rows.find((r) => r.name === name && r.type === "table");
    // Conservative canonical DDL comparison covers columns, NOT NULL, CHECK and PK.
    // Equivalent but unreviewed DDL is rejected rather than inferred compatible.
    if (!row || normalize(row.sql) !== normalize(statement))
      throw new SchemaError();
    const indexes = db.pragma(`index_list(${name})`) as {
      unique: number;
      origin: string;
      name: string;
    }[];
    if (
      indexes.length !== 1 ||
      indexes[0].unique !== 1 ||
      indexes[0].origin !== "pk"
    )
      throw new SchemaError();
    const columns = db.pragma(`index_info(${indexes[0].name})`) as {
      name: string;
    }[];
    const expected =
      name === "published_state_snapshots"
        ? ["state_key", "generation"]
        : ["state_key"];
    if (
      JSON.stringify(columns.map((column) => column.name)) !==
      JSON.stringify(expected)
    )
      throw new SchemaError();
  }
}
