import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import {
  INITIAL_DDL,
  initializeSchema,
  validateSchema,
} from "../../src/backend/storage/schema.js";
import {
  migrate,
  type Migration,
} from "../../src/backend/storage/migrations.js";
import {
  classifyDatabaseError,
  SchemaError,
} from "../../src/backend/storage/errors.js";

const connections: Database.Database[] = [];
function database() {
  const db = new Database(":memory:");
  connections.push(db);
  return db;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) if (db.open) db.close();
});
test("initial schema is four exact tables, version 1, PK index used", () => {
  const db = database();
  initializeSchema(db);
  validateSchema(db);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all(),
  ).toHaveLength(4);
  const plan = JSON.stringify(
    db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT generation,snapshot_json FROM published_state_snapshots WHERE state_key=? ORDER BY generation DESC LIMIT 2",
      )
      .all("weather"),
  );
  expect(plan).toContain("INDEX");
  for (const sql of [
    "INSERT INTO published_state_snapshots VALUES ('',1,'{}')",
    "INSERT INTO published_state_snapshots VALUES ('weather',0,'{}')",
    "INSERT INTO backend_cache VALUES ('weather',NULL)",
    "INSERT INTO acquisition_control VALUES ('', '{}')",
    "INSERT INTO state_generation_counters VALUES ('weather',-1)",
  ])
    expect(() => db.exec(sql)).toThrow();
});
test.each([
  "published_state_snapshots",
  "backend_cache",
  "acquisition_control",
  "state_generation_counters",
])("missing %s is BLOCKED", (table) => {
  const db = database();
  initializeSchema(db);
  db.exec(`DROP TABLE ${table}`);
  expect(() => migrate(db)).toThrow(SchemaError);
});
test("same version with missing CHECK or an extra index is rejected", () => {
  const db = database();
  db.exec(INITIAL_DDL.replace("CHECK (generation > 0)", ""));
  db.pragma("user_version=1");
  expect(() => validateSchema(db)).toThrow(SchemaError);
  const normal = database();
  initializeSchema(normal);
  normal.exec("CREATE INDEX extra ON backend_cache(cache_json)");
  expect(() => validateSchema(normal)).toThrow(SchemaError);
});
test.each([0, 2, 999])(
  "version %s is never initialized or repaired",
  (version) => {
    const db = database();
    db.pragma(`user_version=${version}`);
    expect(() => migrate(db)).toThrow(SchemaError);
    expect(db.pragma("user_version", { simple: true })).toBe(version);
    expect(db.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
  },
);
test("initial DDL and version are atomic on failure", () => {
  const db = database();
  db.exec("CREATE TABLE backend_cache (sentinel TEXT)");
  expect(() => initializeSchema(db)).toThrow();
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all(),
  ).toEqual([{ name: "backend_cache" }]);
});
// Synthetic test-only versions; the production allowlist is empty.
function fixture(db: Database.Database): Migration {
  db.exec("CREATE TABLE old (id INTEGER)");
  db.pragma("user_version=101");
  return {
    from: 101,
    to: 102,
    validateBefore(connection) {
      connection.prepare("SELECT id FROM old").all();
      if (connection.pragma("user_version", { simple: true }) !== 101)
        throw new SchemaError();
    },
    validateAfter(connection) {
      connection.prepare("SELECT id FROM new").all();
      if (connection.pragma("user_version", { simple: true }) !== 102)
        throw new SchemaError();
    },
    apply(connection) {
      connection.exec("CREATE TABLE new (id INTEGER)");
    },
  };
}
test("allowlisted migration rollback preserves prior schema and version", () => {
  const db = database();
  const entry = fixture(db);
  entry.apply = (connection) => {
    connection.exec("CREATE TABLE new (id INTEGER)");
    connection.exec("invalid SQL");
  };
  expect(() => migrate(db, [entry], 102)).toThrow();
  entry.validateBefore(db);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE name='new'").all(),
  ).toEqual([]);
});
test("ambiguous successful commit is reconciled without replay", () => {
  const db = database();
  const entry = fixture(db);
  const apply = vi.spyOn(entry, "apply");
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "COMMIT") throw new Error("unknown outcome");
    return result;
  });
  migrate(db, [entry], 102);
  entry.validateAfter(db);
  expect(apply).toHaveBeenCalledTimes(1);
});
test("rollback failure is BLOCKED", () => {
  const db = database();
  const entry = fixture(db);
  const exec = db.exec.bind(db);
  entry.apply = () => {
    throw new Error("failed");
  };
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "ROLLBACK") throw new Error("failed rollback");
    return exec(sql);
  });
  expect(() => migrate(db, [entry], 102)).toThrow(SchemaError);
});
test.each([
  ["SQLITE_BUSY", "DEGRADED", "L1"],
  ["ENOENT", "DEGRADED", "L2"],
  ["SQLITE_CANTOPEN", "DEGRADED", "L2"],
  ["SQLITE_CORRUPT", "BLOCKED", "L3"],
  ["SQLITE_NOTADB", "BLOCKED", "L3"],
  ["SQLITE_ERROR", "BLOCKED", "L3"],
])("classifies %s", (code, state, layer) =>
  expect(classifyDatabaseError({ code })).toMatchObject({ state, layer }),
);
test("unclassified/OS fatal error does not silently continue", () => {
  expect(() => classifyDatabaseError({ code: "EIO" })).toThrow("L4");
});

test("migration definition failure is BLOCKED after rollback", () => {
  const db = database();
  const entry = fixture(db);
  entry.apply = () => {
    throw new TypeError("invalid definition");
  };
  expect(() => migrate(db, [entry], 102)).toThrow(SchemaError);
  entry.validateBefore(db);
});

test("schema filter excludes only SQLite's literal reserved prefix", () => {
  const db = database();
  initializeSchema(db);
  db.exec("CREATE TABLE sqliteXunexpected (id INTEGER)");
  expect(() => validateSchema(db)).toThrow(SchemaError);
});
