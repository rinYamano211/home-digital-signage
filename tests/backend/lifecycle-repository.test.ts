import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  initializeSchema,
  validateSchema,
} from "../../src/backend/storage/schema.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import {
  BackendStore,
  configureDatabase,
} from "../../src/backend/storage/store.js";
import { LifecycleRepository } from "../../src/backend/storage/lifecycle-repository.js";
import * as coordinationModule from "../../src/backend/storage/connection-coordination.js";
import { PublishedStateRepository } from "../../src/backend/storage/published-state-repository.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import { classifyDatabaseError } from "../../src/backend/storage/errors.js";
import type { ExclusiveLock } from "../../src/backend/storage/lock.js";

// Bypass only platform-specific path checks for unit tests. Real EX / paths / FD
// and Linux Boot ID are covered by the separate native Process tests.
vi.mock("../../src/backend/storage/paths.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/storage/paths.js")>()),
  validateDatabaseFiles: vi.fn(),
}));
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];
const dbs: Database.Database[] = [];
const handles: { close(): void }[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "signage-lifecycle-read-"));
  dirs.push(dir);
  const path = join(dir, "signage.db");
  const db = new Database(path);
  dbs.push(db);
  initializeSchema(db);
  configureDatabase(db, 3);
  db.exec(LIFECYCLE_DDL);
  db.prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,1)").run(
    boot,
  );
  db.pragma("user_version=3");
  const repo = new LifecycleRepository(db);
  const lock = {
    directory: dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock;
  return { db, path, dir, repo, lock };
}
function open(f: ReturnType<typeof fixture>) {
  f.db.close();
  const h = BackendStore.openV3ForStartup(f.lock);
  handles.push(h);
  return h;
}
const busy = () =>
  Object.assign(new Error("synthetic private path"), { code: "SQLITE_BUSY" });
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) h.close();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test.each(["RUNNING", "CLEAN"])(
  "H54-19/21 read valid %s marker without changing Generation or Startup state",
  (state) => {
    const f = fixture();
    f.db
      .prepare("UPDATE backend_lifecycle SET state=?,generation=2")
      .run(state);
    const result = f.repo.read();
    expect(result).toEqual({
      outcome: "found",
      marker: { state, bootId: boot, generation: 2 },
    });
    expect(f.db.inTransaction).toBe(false);
    expect(f.db.prepare("SELECT * FROM startup_generations").all()).toEqual([]);
    expect(
      f.db.prepare("SELECT generation FROM backend_lifecycle").get(),
    ).toEqual({ generation: 2 });
  },
);
test("H54-21 read holds shared busy gate; internal transaction read never commits", () => {
  const f = fixture();
  const exec = vi.spyOn(f.db, "exec");
  expect(f.repo.read().outcome).toBe("found");
  expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
  expect(() => f.repo.readWithinTransaction()).toThrow();
  f.db.exec("BEGIN IMMEDIATE");
  const c = connectionCoordination(f.db);
  c.busy = true;
  exec.mockClear();
  expect(f.repo.readWithinTransaction()).toEqual({
    state: "RUNNING",
    bootId: boot,
    generation: 1,
  });
  expect(exec).not.toHaveBeenCalled();
  expect(f.db.inTransaction).toBe(true);
  c.busy = false;
  f.db.exec("ROLLBACK");
});
test.each(["busy", "blocked", "connectionUnresolved"] as const)(
  "H54-21 read refuses %s without SQLite access",
  (flag) => {
    const f = fixture();
    const c = connectionCoordination(f.db);
    if (flag === "blocked")
      c.blocked = { scope: "database", layer: "L3", reason: "test_block" };
    else c[flag] = true;
    const exec = vi.spyOn(f.db, "exec");
    const prepare = vi.spyOn(f.db, "prepare");
    expect(f.repo.read().outcome).toBe("database_error");
    expect(exec).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    if (flag === "busy") expect(c.busy).toBe(true);
  },
);
test("H54-21 unowned existing transaction is not rolled back or used", () => {
  const f = fixture();
  f.db.exec("BEGIN IMMEDIATE");
  const exec = vi.spyOn(f.db, "exec");
  expect(f.repo.read()).toMatchObject({
    outcome: "database_error",
    reason: "transaction_unresolved",
  });
  expect(exec).not.toHaveBeenCalled();
  expect(f.db.inTransaction).toBe(true);
  expect(connectionCoordination(f.db).connectionUnresolved).toBe(true);
});
test.each([
  "missing",
  "state",
  "nil",
  "bad_uuid",
  "uppercase",
  "negative",
  "unsafe",
  "real",
])("H54-19/32 marker %s is rejected without repair", (fault) => {
  const f = fixture();
  f.db.pragma("ignore_check_constraints=ON");
  const sql: Record<string, string> = {
    missing: "DELETE FROM backend_lifecycle",
    state: "UPDATE backend_lifecycle SET state='INVALID'",
    nil: "UPDATE backend_lifecycle SET boot_id='00000000-0000-0000-0000-000000000000'",
    bad_uuid: "UPDATE backend_lifecycle SET boot_id='x'",
    uppercase: "UPDATE backend_lifecycle SET boot_id=upper(boot_id)",
    negative: "UPDATE backend_lifecycle SET generation=-1",
    unsafe: "UPDATE backend_lifecycle SET generation=9007199254740992",
    real: "UPDATE backend_lifecycle SET generation=1.5",
  };
  f.db.exec(sql[fault]);
  const before = f.db.prepare("SELECT * FROM backend_lifecycle").all();
  expect(f.repo.read()).toMatchObject({
    outcome: "database_error",
    layer: "L3",
  });
  expect(f.db.prepare("SELECT * FROM backend_lifecycle").all()).toEqual(before);
  expect(connectionCoordination(f.db).blocked).toBeDefined();
  expect(f.db.inTransaction).toBe(false);
});
test("H54-19 multiple marker Rows are rejected, never selected arbitrarily", () => {
  const f = fixture();
  f.db.pragma("ignore_check_constraints=ON");
  f.db
    .prepare("INSERT INTO backend_lifecycle VALUES (2,'RUNNING',?,1)")
    .run(boot);
  expect(f.repo.read()).toMatchObject({
    outcome: "database_error",
    layer: "L3",
  });
  expect(f.db.prepare("SELECT * FROM backend_lifecycle").all()).toHaveLength(2);
});
test.each(["BEGIN", "COMMIT"])(
  "H54-21 read %s error returns no marker and releases only a resolved gate",
  (stage) => {
    const f = fixture();
    const original = f.db.exec.bind(f.db);
    vi.spyOn(f.db, "exec").mockImplementation((sql) => {
      if (sql === stage) throw busy();
      return original(sql);
    });
    expect(f.repo.read()).toEqual({
      outcome: "database_error",
      layer: "L1",
      reason: "temporary_sql",
    });
    expect(f.db.inTransaction).toBe(false);
    expect(connectionCoordination(f.db)).toEqual({
      busy: false,
      connectionUnresolved: false,
    });
    vi.mocked(f.db.exec).mockRestore();
    f.db.exec("UPDATE backend_lifecycle SET state='CLEAN'");
    expect(f.repo.read()).toMatchObject({
      outcome: "found",
      marker: { state: "CLEAN" },
    });
    expect(new LifecycleRepository(f.db).read().outcome).toBe("found");
  },
);
test("H54-21 COMMIT after-success throw never returns the cached marker", () => {
  const f = fixture();
  const original = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = original(sql);
    if (sql === "COMMIT") throw busy();
    return r;
  });
  expect(f.repo.read()).toMatchObject({
    outcome: "database_error",
    layer: "L1",
  });
  expect(f.db.inTransaction).toBe(false);
  expect(connectionCoordination(f.db)).toEqual({
    busy: false,
    connectionUnresolved: false,
  });
  vi.mocked(f.db.exec).mockRestore();
  f.db.exec("UPDATE backend_lifecycle SET state='CLEAN'");
  expect(f.repo.read()).toMatchObject({
    outcome: "found",
    marker: { state: "CLEAN" },
  });
});
test("H54-21 unresolved rollback protects shared repositories and prohibits retry", () => {
  const f = fixture();
  const original = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" || sql === "ROLLBACK") throw busy();
    return original(sql);
  });
  expect(f.repo.read()).toMatchObject({
    outcome: "database_error",
    reason: "transaction_unresolved",
  });
  expect(connectionCoordination(f.db).connectionUnresolved).toBe(true);
  const calls = vi.mocked(f.db.exec).mock.calls.length;
  expect(f.repo.read().outcome).toBe("database_error");
  expect(vi.mocked(f.db.exec).mock.calls).toHaveLength(calls);
  expect(connectionCoordination(f.db).busy).toBe(false);
  expect(connectionCoordination(f.db).blocked).toBeDefined();
  expect(new LifecycleRepository(f.db).read().outcome).toBe("database_error");
  expect(
    new PublishedStateRepository(f.db).save("schedule", "{}").outcome,
  ).toBe("unknown");
  expect(vi.mocked(f.db.exec).mock.calls).toHaveLength(calls);
});
test("unknown SQLite-path exception is sanitized and blocked", () => {
  const f = fixture();
  vi.spyOn(f.db, "prepare").mockImplementation(() => {
    throw new Error("synthetic private path");
  });
  const result = f.repo.read();
  expect(result).toEqual({
    outcome: "database_error",
    layer: "L4",
    reason: "storage_failure",
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(connectionCoordination(f.db).blocked).toBeDefined();
});
test("closed borrowed Connection returns no marker and cannot reopen itself", () => {
  const f = fixture();
  f.db.close();
  expect(f.repo.read()).toEqual({
    outcome: "database_error",
    layer: "L2",
    reason: "database_unavailable",
  });
});
test("H54-21 restricted v3 Store owns one Connection, FULL/FK, and limited Startup/read/close capabilities", () => {
  const f = fixture();
  const h = open(f);
  expect(f.lock.assertHeld).toHaveBeenCalledOnce();
  expect(h.startupComplete).toBe(false);
  expect(Object.keys(h).sort()).toEqual([
    "close",
    "lifecycle",
    "startup",
    "startupComplete",
  ]);
  expect(Object.keys(h.lifecycle)).toEqual(["read"]);
  expect(Object.isFrozen(h)).toBe(true);
  expect(Object.isFrozen(h.lifecycle)).toBe(true);
  expect(h.lifecycle.read()).toEqual({
    outcome: "found",
    marker: { state: "RUNNING", bootId: boot, generation: 1 },
  });
  const other = new Database(f.path);
  dbs.push(other);
  configureDatabase(other, 3);
  validateSchema(other, 3);
  expect(
    other.prepare("SELECT * FROM provider_quota_consumptions").all(),
  ).toEqual([]);
  h.close();
  h.close();
  expect(h.lifecycle.read().outcome).toBe("database_error");
});
test("H54-21 released/missing EX prevents even opening the DB", () => {
  const f = fixture();
  vi.mocked(f.lock.assertHeld).mockImplementation(() => {
    throw new Error("lock missing");
  });
  const pragma = vi.spyOn(Database.prototype, "pragma");
  expect(() => BackendStore.openV3ForStartup(f.lock)).toThrow("lock missing");
  expect(pragma).not.toHaveBeenCalled();
});
test.each([1, 2, 4, 99])(
  "H54-20 v3 open rejects v%s without migration and closes acquired Connection",
  (version) => {
    const f = fixture();
    f.db.pragma(`user_version=${version}`);
    f.db.close();
    const close = vi.spyOn(Database.prototype, "close");
    expect(() => BackendStore.openV3ForStartup(f.lock)).toThrow();
    expect(close).toHaveBeenCalledOnce();
    const db = new Database(f.path);
    dbs.push(db);
    expect(db.pragma("user_version", { simple: true })).toBe(version);
  },
);
test("H54-20 v3 open never creates missing DB", () => {
  const f = fixture();
  f.db.close();
  rmSync(f.path);
  expect(() => BackendStore.openV3ForStartup(f.lock)).toThrow();
});
test.each(["table", "marker", "fk"])(
  "H54-20 invalid v3 %s closes before publication",
  (fault) => {
    const f = fixture();
    if (fault === "table") f.db.exec("DROP TABLE history_uncertain_ranges");
    if (fault === "marker") f.db.exec("DELETE FROM backend_lifecycle");
    if (fault === "fk") {
      f.db.pragma("foreign_keys=OFF");
      f.db
        .prepare(
          "INSERT INTO startup_provider_boundaries VALUES (2,'tomorrow.io','UNPROVISIONED',NULL,NULL,NULL,?)",
        )
        .run("a".repeat(64));
    }
    f.db.close();
    const close = vi.spyOn(Database.prototype, "close");
    expect(() => BackendStore.openV3ForStartup(f.lock)).toThrow();
    expect(close).toHaveBeenCalledOnce();
  },
);
test("v3 setup SQLite failure preserves original classification and closes", () => {
  const f = fixture();
  f.db.close();
  const original = Database.prototype.pragma;
  vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
    this: Database.Database,
    sql,
    options,
  ) {
    if (sql === "synchronous = FULL") throw busy();
    return original.call(this, sql, options);
  });
  const close = vi.spyOn(Database.prototype, "close");
  try {
    BackendStore.openV3ForStartup(f.lock);
    throw new Error("Expected open failure");
  } catch (error) {
    expect(classifyDatabaseError(error)).toMatchObject({
      layer: "L1",
      reason: "temporary_sql",
    });
  }
  expect(close).toHaveBeenCalledOnce();
});

test.each(["busy", "blocked", "connectionUnresolved"] as const)(
  "H54-21 v3 opening refuses existing %s coordination and closes",
  (flag) => {
    const f = fixture();
    f.db.close();
    const original = coordinationModule.connectionCoordination;
    vi.spyOn(coordinationModule, "connectionCoordination").mockImplementation(
      (db) => {
        const c = original(db);
        if (flag === "blocked")
          c.blocked = { scope: "database", layer: "L3", reason: "blocked" };
        else c[flag] = true;
        return c;
      },
    );
    const close = vi.spyOn(Database.prototype, "close");
    expect(() => BackendStore.openV3ForStartup(f.lock)).toThrow();
    expect(close).toHaveBeenCalledOnce();
  },
);
test("H54-21 Lifecycle integrity failure protects the shared Connection before PR-B writes", () => {
  const f = fixture();
  f.db.exec("DELETE FROM backend_lifecycle");
  expect(f.repo.read().outcome).toBe("database_error");
  const pub = new PublishedStateRepository(f.db);
  expect(pub.save("schedule", "{}")).toMatchObject({
    outcome: "not_saved",
    scope: "database",
  });
  expect(f.db.prepare("SELECT * FROM published_state_snapshots").all()).toEqual(
    [],
  );
});
test("H54-32 validated v3 facade cannot claim Startup completion or expose sending capabilities", () => {
  const f = fixture();
  const h = open(f);
  expect(() => Reflect.set(h, "startupComplete", true)).not.toThrow();
  expect(Reflect.set(h, "startupComplete", true)).toBe(false);
  expect(h.startupComplete).toBe(false);
  for (const key of [
    "db",
    "quota",
    "acquisitionControl",
    "publishedStates",
    "cache",
    "start",
    "reserve",
    "beginAttempt",
    "readWithinTransaction",
  ])
    expect(h).not.toHaveProperty(key);
  expect(h.lifecycle).not.toHaveProperty("readWithinTransaction");
  expect(h.lifecycle).not.toHaveProperty("save");
  expect(h.lifecycle.read().outcome).toBe("found");
  expect(h.startupComplete).toBe(false);
});

test("Lifecycle reader preserves the largest safe Generation without advancing it", () => {
  const f = fixture();
  f.db
    .prepare("UPDATE backend_lifecycle SET generation=?")
    .run(BigInt(Number.MAX_SAFE_INTEGER));
  expect(f.repo.read()).toEqual({
    outcome: "found",
    marker: {
      state: "RUNNING",
      bootId: boot,
      generation: Number.MAX_SAFE_INTEGER,
    },
  });
});

test.each([
  { code: "SQLITE_BUSY", layer: "L1", reusable: true },
  { code: "SQLITE_CORRUPT", layer: "L3", reusable: false },
  { code: "SQLITE_IOERR", layer: "L4", reusable: false },
])(
  "R59-01 ROLLBACK ended but notification $code controls health independently",
  ({ code, layer, reusable }) => {
    const f = fixture();
    const original = f.db.exec.bind(f.db);
    const exec = vi.spyOn(f.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") throw busy();
      const result = original(sql);
      if (sql === "ROLLBACK")
        throw Object.assign(new Error("synthetic cleanup secret"), { code });
      return result;
    });
    const read = f.repo.read();
    expect(read).toMatchObject({ outcome: "database_error", layer });
    expect(read).not.toHaveProperty("marker");
    expect(JSON.stringify(read)).not.toContain("secret");
    expect(f.db.inTransaction).toBe(false);
    expect(connectionCoordination(f.db).connectionUnresolved).toBe(false);
    expect(connectionCoordination(f.db).busy).toBe(false);
    exec.mockRestore();
    if (reusable) {
      expect(connectionCoordination(f.db).blocked).toBeUndefined();
      expect(f.repo.read().outcome).toBe("found");
      expect(new LifecycleRepository(f.db).read().outcome).toBe("found");
    } else {
      expect(connectionCoordination(f.db).blocked).toBeDefined();
      const sql = vi.spyOn(f.db, "exec");
      expect(f.repo.read().outcome).toBe("database_error");
      expect(new LifecycleRepository(f.db).read().outcome).toBe(
        "database_error",
      );
      expect(
        new PublishedStateRepository(f.db).save("schedule", "{}"),
      ).toMatchObject({ outcome: "not_saved", scope: "database" });
      expect(sql).not.toHaveBeenCalled();
    }
  },
);
test.each(
  [false, true].flatMap((after) =>
    ["SQLITE_CORRUPT", "SQLITE_IOERR"].map((code) => ({ after, code })),
  ),
)(
  "R59-01 fatal COMMIT $code after=$after blocks ended Connection",
  ({ after, code }) => {
    const f = fixture();
    const original = f.db.exec.bind(f.db);
    const exec = vi.spyOn(f.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") {
        if (after) original(sql);
        throw Object.assign(new Error("private commit"), { code });
      }
      return original(sql);
    });
    expect(f.repo.read()).toMatchObject({
      outcome: "database_error",
      layer: code === "SQLITE_CORRUPT" ? "L3" : "L4",
    });
    expect(f.db.inTransaction).toBe(false);
    expect(connectionCoordination(f.db).connectionUnresolved).toBe(false);
    expect(connectionCoordination(f.db).blocked).toBeDefined();
    exec.mockRestore();
    const sql = vi.spyOn(f.db, "exec");
    expect(f.repo.read().outcome).toBe("database_error");
    expect(
      new PublishedStateRepository(f.db).save("schedule", "{}"),
    ).toMatchObject({ outcome: "not_saved" });
    expect(sql).not.toHaveBeenCalled();
  },
);
test.each(["before_begin", "after_commit", "after_rollback"])(
  "R59-01 Transaction getter failure %s remains unresolved after getter recovery",
  (stage) => {
    const f = fixture();
    let unreadable = stage === "before_begin";
    // Native getter is nonconfigurable. A test-only Proxy faults status reads,
    // while every SQLite operation still targets the real Connection.
    const proxy = new Proxy(f.db, {
      get(target, key) {
        if (key === "inTransaction" && unreadable)
          throw new Error("private status");
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const repo = new LifecycleRepository(proxy);
    const original = f.db.exec.bind(f.db);
    vi.spyOn(f.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") {
        if (stage === "after_commit") {
          original(sql);
          unreadable = true;
        }
        throw busy();
      }
      const result = original(sql);
      if (sql === "ROLLBACK") unreadable = true;
      return result;
    });
    expect(repo.read()).toMatchObject({
      outcome: "database_error",
      reason: "transaction_unresolved",
    });
    expect(connectionCoordination(proxy)).toMatchObject({
      busy: false,
      connectionUnresolved: true,
    });
    expect(connectionCoordination(proxy).blocked).toBeDefined();
    unreadable = false;
    vi.mocked(f.db.exec).mockRestore();
    const exec = vi.spyOn(f.db, "exec");
    expect(repo.read().outcome).toBe("database_error");
    expect(new LifecycleRepository(proxy).read().outcome).toBe(
      "database_error",
    );
    expect(
      new PublishedStateRepository(proxy).save("schedule", "{}").outcome,
    ).toBe("unknown");
    expect(exec).not.toHaveBeenCalled();
  },
);
test("R59-01 BEGIN after actual start can reuse only after verified rollback", () => {
  const f = fixture();
  const original = f.db.exec.bind(f.db);
  const exec = vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const result = original(sql);
    if (sql === "BEGIN") throw busy();
    return result;
  });
  expect(f.repo.read()).toMatchObject({
    outcome: "database_error",
    layer: "L1",
  });
  expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
  expect(f.db.inTransaction).toBe(false);
  expect(connectionCoordination(f.db).blocked).toBeUndefined();
  exec.mockRestore();
  expect(f.repo.read().outcome).toBe("found");
});
test.each(["FULL", "FK"])(
  "R59-01 next read revalidates %s after resolved transient COMMIT error",
  (condition) => {
    const f = fixture();
    const original = f.db.exec.bind(f.db);
    const exec = vi.spyOn(f.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") throw busy();
      return original(sql);
    });
    expect(f.repo.read()).toMatchObject({
      outcome: "database_error",
      layer: "L1",
    });
    exec.mockRestore();
    if (condition === "FULL") f.db.pragma("synchronous=NORMAL");
    else f.db.pragma("foreign_keys=OFF");
    expect(f.repo.read()).toMatchObject({
      outcome: "database_error",
      layer: "L3",
    });
    expect(connectionCoordination(f.db).blocked).toBeDefined();
  },
);
