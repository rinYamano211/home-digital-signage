import type Database from "better-sqlite3";
import { LIFECYCLE_DDL } from "./lifecycle-ddl.js";
import { normalizedBootId } from "../time/boot-id.js";
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
export const QUOTA_DDL = String.raw`CREATE TABLE provider_quota_metadata (
    provider_key TEXT PRIMARY KEY,
    history_status TEXT NOT NULL
        CHECK(history_status IN ('ACTIVE', 'SUSPENDED')),
    initialized_at_ms INTEGER NOT NULL,
    last_sequence INTEGER NOT NULL DEFAULT 0
        CHECK(last_sequence >= 0)
);
CREATE TABLE provider_quota_consumptions (
    provider_key TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    reserved_at_ms INTEGER NOT NULL,
    PRIMARY KEY (provider_key, sequence),
    FOREIGN KEY (provider_key)
        REFERENCES provider_quota_metadata(provider_key)
);
CREATE INDEX idx_provider_quota_reserved_at
ON provider_quota_consumptions (provider_key, reserved_at_ms);`;
const normalize = (sql: string) =>
  sql
    .trim()
    .replace(/;$/, "")
    .replace(/'[^']*'|[^']+/g, (part) =>
      part.startsWith("'") ? part : part.toLowerCase().replace(/\s+/g, ""),
    );
export function enableForeignKeys(db: Database.Database): void {
  db.pragma("foreign_keys=ON");
  if (db.pragma("foreign_keys", { simple: true }) !== 1)
    throw new SchemaError();
}
export function initializeSchema(db: Database.Database): void {
  enableForeignKeys(db);
  db.transaction(() => {
    db.exec(INITIAL_DDL);
    db.exec(QUOTA_DDL);
    db.pragma("user_version=2");
    validateSchema(db);
  })();
}
/** v1 exists only as an explicit pre-upgrade validator; runtime defaults to v2. */
export function validateSchema(
  db: Database.Database,
  version: 1 | 2 | 3 = 2,
): void {
  if (db.pragma("user_version", { simple: true }) !== version)
    throw new SchemaError();
  if (version >= 2 && db.pragma("foreign_keys", { simple: true }) !== 1)
    throw new SchemaError();
  const statements = (
    INITIAL_DDL +
    (version >= 2 ? QUOTA_DDL : "") +
    (version === 3 ? LIFECYCLE_DDL : "")
  )
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const rows = db
    .prepare(
      "SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all() as { name: string; type: string; sql: string }[];
  if (rows.length !== statements.length) throw new SchemaError();
  for (const statement of statements) {
    const match = /^CREATE (TABLE|INDEX) (\w+)/.exec(statement)!;
    const [, type, name] = match;
    const row = rows.find(
      (r) => r.name === name && r.type === type.toLowerCase(),
    );
    if (!row || normalize(row.sql) !== normalize(statement))
      throw new SchemaError();
    if (type === "INDEX") {
      const columns = db.pragma(`index_info(${name})`) as { name: string }[];
      if (
        JSON.stringify(columns.map((c) => c.name)) !==
        JSON.stringify(["provider_key", "reserved_at_ms"])
      )
        throw new SchemaError();
      continue;
    }
    const indexes = db.pragma(`index_list(${name})`) as {
      unique: number;
      origin: string;
      name: string;
      partial: number;
    }[];
    const hasTimeIndex = name === "provider_quota_consumptions";
    const rowidPrimary = ["backend_lifecycle", "startup_generations"].includes(
      name,
    );
    if (indexes.length !== (rowidPrimary ? 0 : hasTimeIndex ? 2 : 1))
      throw new SchemaError();
    const keys: Record<string, string[]> = {
      published_state_snapshots: ["state_key", "generation"],
      provider_quota_consumptions: ["provider_key", "sequence"],
      provider_quota_metadata: ["provider_key"],
      startup_provider_boundaries: ["generation", "provider_key"],
      history_uncertain_ranges: ["provider_key", "generation", "range_id"],
    };
    if (!rowidPrimary) {
      const pk = indexes.find((i) => i.origin === "pk");
      if (!pk || pk.unique !== 1 || pk.partial !== 0) throw new SchemaError();
      const columns = db.pragma(`index_info(${pk.name})`) as { name: string }[];
      if (
        JSON.stringify(columns.map((c) => c.name)) !==
        JSON.stringify(keys[name] ?? ["state_key"])
      )
        throw new SchemaError();
    } else {
      const columns = db.pragma(`table_info(${name})`) as {
        name: string;
        type: string;
        pk: number;
        notnull: number;
      }[];
      const pk = columns.filter((c) => c.pk !== 0);
      if (
        pk.length !== 1 ||
        pk[0].name !==
          (name === "backend_lifecycle" ? "lifecycle_key" : "generation") ||
        pk[0].type !== "INTEGER" ||
        pk[0].notnull !== 1
      )
        throw new SchemaError();
    }
    if (
      hasTimeIndex &&
      !indexes.some(
        (i) =>
          i.name === "idx_provider_quota_reserved_at" &&
          i.origin === "c" &&
          i.unique === 0 &&
          i.partial === 0,
      )
    )
      throw new SchemaError();
    const fk = db.pragma(`foreign_key_list(${name})`) as {
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }[];
    if (hasTimeIndex) {
      if (
        fk.length !== 1 ||
        fk[0].table !== "provider_quota_metadata" ||
        fk[0].from !== "provider_key" ||
        fk[0].to !== "provider_key" ||
        fk[0].on_update !== "NO ACTION" ||
        fk[0].on_delete !== "NO ACTION" ||
        fk[0].match !== "NONE"
      )
        throw new SchemaError();
    } else if (
      name === "startup_provider_boundaries" ||
      name === "history_uncertain_ranges"
    ) {
      const expected =
        name === "startup_provider_boundaries"
          ? [["startup_generations", "generation", "generation"]]
          : [
              ["startup_provider_boundaries", "generation", "generation"],
              ["startup_provider_boundaries", "provider_key", "provider_key"],
            ];
      if (
        JSON.stringify(fk.map((f) => [f.table, f.from, f.to])) !==
          JSON.stringify(expected) ||
        fk.some(
          (f) =>
            f.on_update !== "NO ACTION" ||
            f.on_delete !== "NO ACTION" ||
            f.match !== "NONE",
        )
      )
        throw new SchemaError();
    } else if (fk.length !== 0) throw new SchemaError();
  }
  if (version === 3) {
    if (
      db.pragma("journal_mode", { simple: true }) !== "wal" ||
      db.pragma("synchronous", { simple: true }) !== 2
    )
      throw new SchemaError();
    if (db.pragma("quick_check", { simple: true }) !== "ok")
      throw new SchemaError();
    if ((db.pragma("foreign_key_check") as unknown[]).length !== 0)
      throw new SchemaError();
    validateLifecycleMarker(db);
  }
}

export interface LifecycleMarker {
  readonly state: "RUNNING" | "CLEAN";
  readonly bootId: string;
  readonly generation: number;
}
/** Marker validity is not Startup evidence, History Trust or send permission. */
export function validateLifecycleMarker(
  db: Database.Database,
): LifecycleMarker {
  const rows = db
    .prepare(
      "SELECT lifecycle_key,state,boot_id,generation FROM backend_lifecycle",
    )
    .safeIntegers(true)
    .all() as {
    lifecycle_key: unknown;
    state: unknown;
    boot_id: unknown;
    generation: unknown;
  }[];
  if (rows.length !== 1) throw new SchemaError();
  const r = rows[0];
  if (
    r.lifecycle_key !== 1n ||
    !["RUNNING", "CLEAN"].includes(r.state as string) ||
    typeof r.boot_id !== "string" ||
    normalizedBootId(r.boot_id) !== r.boot_id ||
    typeof r.generation !== "bigint" ||
    r.generation < 1n ||
    r.generation > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new SchemaError();
  return Object.freeze({
    state: r.state as "RUNNING" | "CLEAN",
    bootId: r.boot_id,
    generation: Number(r.generation),
  });
}
