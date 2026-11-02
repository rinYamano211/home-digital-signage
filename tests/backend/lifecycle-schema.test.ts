import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  initializeSchema,
  validateSchema,
  INITIAL_DDL,
} from "../../src/backend/storage/schema.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import {
  migrate,
  V1_TO_V2,
  MIGRATIONS,
} from "../../src/backend/storage/migrations.js";
import { v2ToV3Migration } from "../../src/backend/storage/migration-v3.js";
import { configureDatabase } from "../../src/backend/storage/store.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import {
  readOsBootId,
  normalizedBootId,
} from "../../src/backend/time/boot-id.js";

const os = vi.hoisted(() => ({
  platform: "linux",
  boot: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE\n",
  fail: false,
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  platform: () => os.platform,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === "/proc/sys/kernel/random/boot_id") {
        if (os.fail) throw new Error("synthetic private path");
        return os.boot;
      }
      return Reflect.apply(actual.readFileSync, actual, args);
    },
  };
});
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];
const connections: Database.Database[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "signage-v3-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const db = new Database(path);
  connections.push(db);
  initializeSchema(db);
  configureDatabase(db, 3);
  return { db, path };
}
function upgrade(db: Database.Database) {
  migrate(db, [v2ToV3Migration()], 3);
}
function marker(db: Database.Database) {
  return db.prepare("SELECT * FROM backend_lifecycle").safeIntegers(true).all();
}
afterEach(() => {
  vi.restoreAllMocks();
  os.platform = "linux";
  os.boot = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE\n";
  os.fail = false;
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
test("H54-19/20 explicit v3 keeps six tables and data; commits only initial RUNNING Gen1", () => {
  const { db } = fixture();
  db.exec(
    "INSERT INTO published_state_snapshots VALUES ('schedule',1,'snapshot'); INSERT INTO backend_cache VALUES ('schedule','cache'); INSERT INTO acquisition_control VALUES ('schedule','control'); INSERT INTO state_generation_counters VALUES ('schedule',1); INSERT INTO provider_quota_metadata VALUES ('tomorrow.io','ACTIVE',0,1); INSERT INTO provider_quota_consumptions VALUES ('tomorrow.io',1,1);",
  );
  const old = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  const data = old.map((r) => db.prepare(`SELECT * FROM ${r.name}`).all());
  const exec = vi.spyOn(db, "exec");
  upgrade(db);
  expect(db.pragma("user_version", { simple: true })).toBe(3);
  validateSchema(db, 3);
  expect(
    db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all(),
  ).toHaveLength(10);
  expect(marker(db)).toEqual([
    { lifecycle_key: 1n, state: "RUNNING", boot_id: boot, generation: 1n },
  ]);
  for (let i = 0; i < old.length; i++) {
    expect(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(old[i].name),
    ).toEqual({ sql: old[i].sql });
    expect(db.prepare(`SELECT * FROM ${old[i].name}`).all()).toEqual(data[i]);
  }
  for (const n of [
    "startup_generations",
    "startup_provider_boundaries",
    "history_uncertain_ranges",
  ])
    expect(db.prepare(`SELECT * FROM ${n}`).all()).toEqual([]);
  expect(
    exec.mock.calls.filter(([sql]) => sql === "BEGIN IMMEDIATE"),
  ).toHaveLength(1);
  expect(exec.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
});
test("H54-19 normal startup never upgrades v2 and continues rejecting v3", () => {
  const { db } = fixture();
  migrate(db);
  expect(db.pragma("user_version", { simple: true })).toBe(2);
  expect(MIGRATIONS).toHaveLength(0);
  expect(() => migrate(db, [], 3)).toThrow();
  expect(db.pragma("user_version", { simple: true })).toBe(2);
  // A rejected administrative operation requires a fresh Connection, not auto retry.
  const other = fixture();
  upgrade(other.db);
  expect(() => migrate(other.db)).toThrow();
});
test("H54-19 v1->v2 explicit contract remains separate", () => {
  const { db } = fixture();
  // Use a separate file for the actual old schema.
  const path = join(dirs.at(-1)!, "v1.sqlite");
  const old = new Database(path);
  connections.push(old);
  old.exec(INITIAL_DDL);
  old.pragma("user_version=1");
  migrate(old, [V1_TO_V2]);
  validateSchema(old, 2);
  expect(old.pragma("user_version", { simple: true })).toBe(2);
  validateSchema(db, 2);
});
test.each(["delete", "normal", "memory"])(
  "H54-21 refuses non-WAL/FULL mode %s before DDL",
  (mode) => {
    const { db } = fixture();
    if (mode === "normal") db.pragma("synchronous=NORMAL");
    else db.pragma(`journal_mode=${mode}`);
    expect(() => upgrade(db)).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name='backend_lifecycle'",
        )
        .get(),
    ).toBeUndefined();
  },
);
test("H54-19 v3 validation survives a fresh Connection with FULL and FK", () => {
  const { db, path } = fixture();
  upgrade(db);
  db.close();
  const next = new Database(path, { fileMustExist: true });
  connections.push(next);
  expect(() => validateSchema(next, 3)).toThrow();
  configureDatabase(next, 3);
  validateSchema(next, 3);
  expect(marker(next)[0]).toMatchObject({ generation: 1n, boot_id: boot });
  next.pragma("synchronous=NORMAL");
  expect(() => validateSchema(next, 3)).toThrow();
});
test.each([0, 4, 999])("H54-19 rejects unknown/wrong version %s", (version) => {
  const { db } = fixture();
  db.pragma(`user_version=${version}`);
  expect(() => upgrade(db)).toThrow();
  expect(db.pragma("user_version", { simple: true })).toBe(version);
});
test.each(["table", "index", "constraint"])(
  "H54-19 strict schema rejects %s mismatch",
  (fault) => {
    const { db } = fixture();
    if (fault === "constraint") {
      db.exec(LIFECYCLE_DDL.replace("generation >= 1", "generation >= 0"));
      db.prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,1)").run(
        boot,
      );
      db.pragma("user_version=3");
    } else upgrade(db);
    if (fault === "table") db.exec("DROP TABLE history_uncertain_ranges");
    if (fault === "index")
      db.exec("CREATE INDEX unexpected ON backend_lifecycle (state)");
    expect(() => validateSchema(db, 3)).toThrow();
  },
);
test.each(["missing", "uuid", "unsafe", "real"])(
  "H54-19 rejects invalid lifecycle marker %s",
  (fault) => {
    const { db } = fixture();
    upgrade(db);
    db.pragma("ignore_check_constraints=ON");
    if (fault === "missing") db.exec("DELETE FROM backend_lifecycle");
    if (fault === "uuid")
      db.exec("UPDATE backend_lifecycle SET boot_id='not-an-os-uuid'");
    if (fault === "unsafe")
      db.exec("UPDATE backend_lifecycle SET generation=9007199254740992");
    if (fault === "real")
      db.exec("UPDATE backend_lifecycle SET generation=1.5");
    expect(() => validateSchema(db, 3)).toThrow();
  },
);
function parent(db: Database.Database) {
  db.prepare("INSERT INTO startup_generations VALUES (2,?,'RUNNING',?,1)").run(
    boot,
    boot,
  );
}
function boundary(db: Database.Database, values: unknown[]) {
  return db
    .prepare(
      "INSERT INTO startup_provider_boundaries VALUES (2,'tomorrow.io',?,?,?,?,?)",
    )
    .run(...values);
}
test("H54-19 PROVISIONED/NULL rejected; UNPROVISIONED/NULL and PROVISIONED/0 distinct", () => {
  const { db } = fixture();
  upgrade(db);
  parent(db);
  const hash = "a".repeat(64);
  expect(() =>
    boundary(db, ["PROVISIONED", null, "ACTIVE", 0, hash]),
  ).toThrow();
  boundary(db, ["UNPROVISIONED", null, null, null, hash]);
  db.exec("DELETE FROM startup_provider_boundaries");
  boundary(db, ["PROVISIONED", 0, "ACTIVE", 0, hash]);
  validateSchema(db, 3);
});
test.each([
  ["UNPROVISIONED", 0, null, null, "a".repeat(64)],
  ["PROVISIONED", -1, "ACTIVE", 0, "a".repeat(64)],
  ["PROVISIONED", 0, null, 0, "a".repeat(64)],
  ["PROVISIONED", 0, "ACTIVE", null, "a".repeat(64)],
  ["PROVISIONED", 0, "ACTIVE", 1.5, "a".repeat(64)],
  ["PROVISIONED", 0, "ACTIVE", 0, "A".repeat(64)],
])("H54-19 Boundary constraint rejects %j", (...values) => {
  const { db } = fixture();
  upgrade(db);
  parent(db);
  expect(() => boundary(db, values)).toThrow();
});
test("H54-07/19 composite FK, PK and integer Range constraints are enforced", () => {
  const { db } = fixture();
  upgrade(db);
  expect(() =>
    boundary(db, ["UNPROVISIONED", null, null, null, "a".repeat(64)]),
  ).toThrow();
  parent(db);
  boundary(db, ["UNPROVISIONED", null, null, null, "a".repeat(64)]);
  const insert = db.prepare(
    "INSERT INTO history_uncertain_ranges VALUES ('tomorrow.io',2,?,?,?)",
  );
  expect(() => insert.run(1, 2, 1)).toThrow();
  expect(() => insert.run(1.5, 1, 2)).toThrow();
  insert.run(1, 1, 2);
  expect(() => insert.run(1, 3, 4)).toThrow();
  expect(() => db.exec("DELETE FROM startup_provider_boundaries")).toThrow();
  validateSchema(db, 3);
});
test("H54-19 foreign_key_check rejects externally injected orphan", () => {
  const { db } = fixture();
  upgrade(db);
  db.pragma("foreign_keys=OFF");
  db.prepare(
    "INSERT INTO startup_provider_boundaries VALUES (2,'tomorrow.io','UNPROVISIONED',NULL,NULL,NULL,?)",
  ).run("a".repeat(64));
  db.pragma("foreign_keys=ON");
  expect(() => validateSchema(db, 3)).toThrow();
});
test("H54-19 injected mid-DDL failure rolls back schema, marker and Version atomically", () => {
  const { db } = fixture();
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === LIFECYCLE_DDL) {
      exec(sql);
      throw new Error("DDL failure");
    }
    return exec(sql);
  });
  expect(() => upgrade(db)).toThrow();
  expect(db.inTransaction).toBe(false);
  expect(db.pragma("user_version", { simple: true })).toBe(2);
  expect(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE name='backend_lifecycle'")
      .get(),
  ).toBeUndefined();
  validateSchema(db, 2);
});
test.each([false, true])(
  "H54-19 COMMIT exception after=%s reconciles once, never replays",
  (after) => {
    const { db } = fixture();
    const migration = v2ToV3Migration();
    const exec = db.exec.bind(db);
    let commits = 0,
      ddl = 0;
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === LIFECYCLE_DDL) ddl++;
      if (sql === "COMMIT") {
        commits++;
        if (after) exec(sql);
        throw new Error("unknown");
      }
      return exec(sql);
    });
    if (after) {
      migrate(db, [migration], 3);
      validateSchema(db, 3);
    } else {
      expect(() => migrate(db, [migration], 3)).toThrow();
      validateSchema(db, 2);
    }
    expect(ddl).toBe(1);
    expect(commits).toBe(1);
    expect(db.inTransaction).toBe(false);
  },
);
test.each(["version", "marker", "rollback"])(
  "H54-19 unknown %s fails closed, preserves shared protection",
  (fault) => {
    const { db } = fixture();
    const exec = db.exec.bind(db);
    const pragma = db.pragma.bind(db);
    let committed = false,
      ddl = 0;
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === LIFECYCLE_DDL) ddl++;
      if (sql === "COMMIT") {
        if (fault !== "rollback") {
          exec(sql);
          committed = true;
          if (fault === "marker")
            exec("UPDATE backend_lifecycle SET generation=2");
        }
        throw new Error("unknown");
      }
      if (sql === "ROLLBACK" && fault === "rollback")
        throw new Error("rollback failed");
      return exec(sql);
    });
    vi.spyOn(db, "pragma").mockImplementation((sql, options) => {
      if (committed && fault === "version" && sql === "user_version")
        throw new Error("unreadable");
      return pragma(sql, options);
    });
    expect(() => upgrade(db)).toThrow();
    expect(ddl).toBe(1);
    expect(connectionCoordination(db).blocked).toBeDefined();
    if (fault === "rollback")
      expect(connectionCoordination(db).connectionUnresolved).toBe(true);
    const calls = vi.mocked(db.exec).mock.calls.length;
    expect(() => upgrade(db)).toThrow();
    expect(vi.mocked(db.exec).mock.calls).toHaveLength(calls);
    vi.restoreAllMocks();
    if (db.inTransaction) db.exec("ROLLBACK");
  },
);
test.each(["busy", "blocked", "connectionUnresolved"] as const)(
  "H54-21 refuses shared Connection %s without BEGIN",
  (flag) => {
    const { db } = fixture();
    const c = connectionCoordination(db);
    if (flag === "blocked") c.blocked = { scope: "database", reason: "test" };
    else c[flag] = true;
    const exec = vi.spyOn(db, "exec");
    expect(() => upgrade(db)).toThrow();
    expect(exec).not.toHaveBeenCalled();
    if (flag === "busy") expect(c.busy).toBe(true);
  },
);
test("approved OS source normalizes case and one line ending", () => {
  expect(readOsBootId()).toBe(boot);
  expect(normalizedBootId(boot)).toBe(boot);
});
test.each(["bad", " " + boot, boot + "\n\n", ""])(
  "invalid OS Boot ID %j fails before Migration",
  (raw) => {
    os.boot = raw;
    const { db } = fixture();
    expect(() => upgrade(db)).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  },
);
test("OS read failure and non-Linux cannot manufacture a Boot ID", () => {
  os.fail = true;
  expect(() => readOsBootId()).toThrow();
  os.fail = false;
  os.platform = "win32";
  expect(() => readOsBootId()).toThrow();
});

test("H54-19 failure after Marker insert rolls back Marker and all DDL", () => {
  const { db } = fixture();
  const pragma = db.pragma.bind(db);
  vi.spyOn(db, "pragma").mockImplementation((sql, options) => {
    if (sql === "user_version = 3") throw new Error("version write failure");
    return pragma(sql, options);
  });
  expect(() => upgrade(db)).toThrow();
  expect(db.pragma("user_version", { simple: true })).toBe(2);
  expect(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE name='backend_lifecycle'")
      .get(),
  ).toBeUndefined();
  expect(db.inTransaction).toBe(false);
  validateSchema(db, 2);
});
test("H54-19 invalid provider CHECK data is rejected even with exact DDL", () => {
  const { db } = fixture();
  upgrade(db);
  parent(db);
  db.pragma("ignore_check_constraints=ON");
  boundary(db, ["PROVISIONED", null, "ACTIVE", 0, "a".repeat(64)]);
  db.pragma("ignore_check_constraints=OFF");
  expect(() => validateSchema(db, 3)).toThrow();
});

test("nil OS Boot UUID is rejected independently of case normalization", () => {
  const nil = "00000000-0000-0000-0000-000000000000";
  // Nil contains no letters: uppercase/lowercase are the same UUID spelling.
  expect(normalizedBootId(nil)).toBeNull();
  expect(normalizedBootId(nil.toUpperCase())).toBeNull();
  expect(normalizedBootId(nil.toLowerCase())).toBeNull();
});
test.each(["", "\n", "\r\n"])(
  "nil OS Boot UUID with ending %j cannot reach Migration",
  (ending) => {
    os.boot = "00000000-0000-0000-0000-000000000000" + ending;
    expect(() => readOsBootId()).toThrow();
    const { db } = fixture();
    const exec = vi.spyOn(db, "exec");
    expect(() => upgrade(db)).toThrow();
    expect(exec).not.toHaveBeenCalled();
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.inTransaction).toBe(false);
  },
);
test("v3 Lifecycle Marker cannot use nil OS Boot UUID", () => {
  const { db } = fixture();
  upgrade(db);
  db.exec(
    "UPDATE backend_lifecycle SET boot_id='00000000-0000-0000-0000-000000000000'",
  );
  expect(() => validateSchema(db, 3)).toThrow();
});
