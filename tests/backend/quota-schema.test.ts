import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import {
  INITIAL_DDL,
  QUOTA_DDL,
  initializeSchema,
  validateSchema,
  enableForeignKeys,
} from "../../src/backend/storage/schema.js";
import {
  migrate,
  V1_TO_V2,
  MIGRATIONS,
} from "../../src/backend/storage/migrations.js";
import { SchemaError } from "../../src/backend/storage/errors.js";
const opened: Database.Database[] = [];
function db() {
  const d = new Database(":memory:");
  opened.push(d);
  return d;
}
function v1() {
  const d = db();
  d.exec(INITIAL_DDL);
  d.pragma("user_version=1");
  return d;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of opened.splice(0)) if (d.open) d.close();
});
test("v2 strict Schema has six tables, FK and time index; metadata remains empty", () => {
  const d = db();
  initializeSchema(d);
  validateSchema(d);
  expect(d.pragma("user_version", { simple: true })).toBe(2);
  expect(d.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(
    d.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all(),
  ).toHaveLength(6);
  expect(d.prepare("SELECT * FROM provider_quota_metadata").all()).toEqual([]);
  expect(() =>
    d
      .prepare(
        "INSERT INTO provider_quota_consumptions VALUES ('tomorrow.io',1,1)",
      )
      .run(),
  ).toThrow();
  expect(
    JSON.stringify(
      d
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM provider_quota_consumptions WHERE provider_key=? AND reserved_at_ms>=?",
        )
        .all("tomorrow.io", 0),
    ),
  ).toContain("idx_provider_quota_reserved_at");
});
test("v1 stays unchanged on ordinary startup: old release cannot read/write v2", () => {
  const d = v1();
  expect(MIGRATIONS).toHaveLength(0);
  expect(() => migrate(d)).toThrow(SchemaError);
  expect(d.pragma("user_version", { simple: true })).toBe(1);
  validateSchema(d, 1);
  migrate(d, [V1_TO_V2]);
  expect(() => validateSchema(d, 1)).toThrow(SchemaError);
  validateSchema(d, 2);
  migrate(d); // v2 restart
});
test("explicit v1->v2 keeps all four tables and data, emits BEGIN IMMEDIATE", () => {
  const d = v1();
  d.exec(
    "INSERT INTO published_state_snapshots VALUES ('schedule',1,'{}'); INSERT INTO state_generation_counters VALUES ('schedule',1); INSERT INTO backend_cache VALUES ('schedule','cache'); INSERT INTO acquisition_control VALUES ('schedule','control');",
  );
  const before = d
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name",
    )
    .all();
  const exec = vi.spyOn(d, "exec");
  migrate(d, [V1_TO_V2]);
  expect(exec.mock.calls.some(([s]) => s === "BEGIN IMMEDIATE")).toBe(true);
  for (const row of before as { name: string; sql: string }[])
    expect(
      d.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(row.name),
    ).toEqual({ sql: row.sql });
  expect(d.prepare("SELECT cache_json FROM backend_cache").get()).toEqual({
    cache_json: "cache",
  });
  expect(
    d.prepare("SELECT control_json FROM acquisition_control").get(),
  ).toEqual({ control_json: "control" });
  expect(
    d.prepare("SELECT generation FROM published_state_snapshots").get(),
  ).toEqual({ generation: 1 });
  expect(
    d.prepare("SELECT last_generation FROM state_generation_counters").get(),
  ).toEqual({ last_generation: 1 });
  expect(d.prepare("SELECT * FROM provider_quota_metadata").all()).toEqual([]);
});
test.each([0, 3, 99])("v%s never auto-initializes", (version) => {
  const d = db();
  d.pragma(`user_version=${version}`);
  expect(() => migrate(d, [V1_TO_V2])).toThrow();
  expect(d.pragma("user_version", { simple: true })).toBe(version);
});
test.each([
  "provider_quota_metadata",
  "provider_quota_consumptions",
  "acquisition_control",
])("missing %s rejected", (table) => {
  const d = db();
  initializeSchema(d);
  d.pragma("foreign_keys=OFF");
  d.exec(`DROP TABLE ${table}`);
  enableForeignKeys(d);
  expect(() => validateSchema(d)).toThrow();
});
test.each([
  "CREATE INDEX extra_quota ON provider_quota_consumptions(reserved_at_ms)",
  "DROP INDEX idx_provider_quota_reserved_at",
  "CREATE TABLE unexpected (a INTEGER)",
])("unknown or missing structure rejected: %s", (sql) => {
  const d = db();
  initializeSchema(d);
  d.exec(sql);
  expect(() => validateSchema(d)).toThrow();
});
test.each([
  ["'ACTIVE', 'SUSPENDED'", "'active', 'SUSPENDED'"],
  ["DEFAULT 0", "DEFAULT 1"],
  ["CHECK(sequence > 0)", "CHECK(sequence >= 0)"],
  [
    "REFERENCES provider_quota_metadata(provider_key)",
    "REFERENCES provider_quota_metadata(provider_key) ON DELETE CASCADE",
  ],
  ["provider_key, reserved_at_ms", "reserved_at_ms, provider_key"],
])("unreviewed DDL mutation %s rejected", (a, b) => {
  const d = db();
  enableForeignKeys(d);
  d.exec(INITIAL_DDL);
  d.exec(QUOTA_DDL.replace(a, b));
  d.pragma("user_version=2");
  expect(() => validateSchema(d)).toThrow();
});
test("FK off fails v2 validation, including inside an existing Transaction", () => {
  const d = db();
  initializeSchema(d);
  d.pragma("foreign_keys=OFF");
  expect(() => validateSchema(d)).toThrow();
  d.exec("BEGIN");
  expect(() => enableForeignKeys(d)).toThrow();
  d.exec("ROLLBACK");
});
test("interrupted DDL rolls back schema and Version with no replay", () => {
  const d = v1();
  let applied = 0;
  const entry = {
    ...V1_TO_V2,
    apply(connection: Database.Database) {
      applied++;
      connection.exec(QUOTA_DDL);
      throw new Error("fail");
    },
  };
  expect(() => migrate(d, [entry])).toThrow();
  expect(applied).toBe(1);
  validateSchema(d, 1);
});
test.each([false, true])(
  "Migration COMMIT exception after=%s reconciles actual Version and Schema",
  (after) => {
    const d = v1();
    const exec = d.exec.bind(d);
    let once = true;
    vi.spyOn(d, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT" && once) {
        once = false;
        if (after) exec(sql);
        throw new Error("commit uncertain");
      }
      return exec(sql);
    });
    if (after) {
      migrate(d, [V1_TO_V2]);
      validateSchema(d, 2);
    } else {
      expect(() => migrate(d, [V1_TO_V2])).toThrow();
      validateSchema(d, 1);
    }
  },
);
test("Migration result unreadable is rejected; no unconditional DDL retry", () => {
  const d = v1();
  const exec = d.exec.bind(d);
  const pragma = d.pragma.bind(d);
  let committed = false;
  let calls = 0;
  vi.spyOn(d, "exec").mockImplementation((sql) => {
    if (sql === QUOTA_DDL) calls++;
    const r = exec(sql);
    if (sql === "COMMIT") {
      committed = true;
      throw new Error();
    }
    return r;
  });
  vi.spyOn(d, "pragma").mockImplementation((sql, options) => {
    if (committed && sql === "user_version") throw new Error();
    return pragma(sql, options);
  });
  expect(() => migrate(d, [V1_TO_V2])).toThrow();
  expect(calls).toBe(1);
});

test("Migration never rolls back a caller-owned existing Transaction", () => {
  const d = v1();
  d.exec("BEGIN");
  expect(() => migrate(d, [V1_TO_V2])).toThrow();
  expect(d.inTransaction).toBe(true);
  d.exec("ROLLBACK");
  validateSchema(d, 1);
});

test("bad v1 structure is not upgraded or repaired", () => {
  const d = v1();
  d.exec("CREATE INDEX unknown_v1 ON backend_cache(cache_json)");
  expect(() => migrate(d, [V1_TO_V2])).toThrow();
  expect(d.pragma("user_version", { simple: true })).toBe(1);
  expect(
    d
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name='provider_quota_metadata'",
      )
      .all(),
  ).toEqual([]);
});
test("post-Commit invalid v2 Schema never succeeds or replays", () => {
  const d = v1();
  const exec = d.exec.bind(d);
  let applied = 0;
  vi.spyOn(d, "exec").mockImplementation((sql) => {
    if (sql === QUOTA_DDL) applied++;
    const r = exec(sql);
    if (sql === "COMMIT") {
      exec("CREATE INDEX bad ON provider_quota_consumptions(sequence)");
      throw new Error();
    }
    return r;
  });
  expect(() => migrate(d, [V1_TO_V2])).toThrow();
  expect(applied).toBe(1);
});
