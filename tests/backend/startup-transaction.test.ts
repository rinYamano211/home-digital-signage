import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  initializeSchema,
  validateSchema,
} from "../../src/backend/storage/schema.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import {
  BackendStore,
  configureDatabase,
} from "../../src/backend/storage/store.js";
import {
  StartupTransactionService,
  STARTUP_PROVIDERS,
} from "../../src/backend/storage/startup-transaction.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import { PublishedStateRepository } from "../../src/backend/storage/published-state-repository.js";
import { historyFingerprint } from "../../src/backend/quota/history-fingerprint.js";
import { TOMORROW_IO } from "../../src/backend/quota/quota-guard.js";
import type { ExclusiveLock } from "../../src/backend/storage/lock.js";
import { readOsBootId } from "../../src/backend/time/boot-id.js";
vi.mock("../../src/backend/time/boot-id.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/time/boot-id.js")>()),
  readOsBootId: vi.fn(),
}));
vi.mock("../../src/backend/storage/paths.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/storage/paths.js")>()),
  validateDatabaseFiles: vi.fn(),
}));
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const nextBoot = "11111111-2222-3333-4444-555555555555";
const dirs: string[] = [];
const dbs: Database.Database[] = [];
const handles: { close(): void }[] = [];
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) h.close();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "signage-atomic-startup-"));
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
  const lock = {
    directory: dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock;
  return { db, path, lock, service: new StartupTransactionService(db, lock) };
}
type Fixture = ReturnType<typeof fixture>;
const execute = (f: Fixture) => f.service.execute({ bootId: boot });
function snapshot(f: Fixture) {
  return Object.fromEntries(
    [
      "backend_lifecycle",
      "startup_generations",
      "startup_provider_boundaries",
      "provider_quota_metadata",
      "provider_quota_consumptions",
      "published_state_snapshots",
      "backend_cache",
    ].map((t) => [t, f.db.prepare(`SELECT * FROM ${t}`).all()]),
  );
}
function reopen(f: Fixture) {
  f.db.close();
  const db = new Database(f.path);
  dbs.push(db);
  configureDatabase(db, 3);
  return { ...f, db, service: new StartupTransactionService(db, f.lock) };
}
function provision(f: Fixture, count = 2) {
  f.db
    .prepare("INSERT INTO provider_quota_metadata VALUES (?,'ACTIVE',0,?)")
    .run(TOMORROW_IO, count);
  for (let i = 1; i <= count; i++)
    f.db
      .prepare("INSERT INTO provider_quota_consumptions VALUES (?,?,?)")
      .run(TOMORROW_IO, i, i * 10);
}
function gen2(f: Fixture) {
  expect(execute(f)).toEqual({ outcome: "committed", generation: 2 });
  return reopen(f);
}
const sqlFailure = (code = "SQLITE_BUSY") =>
  Object.assign(new Error("private credential"), { code });
function execFault(
  f: Fixture,
  sql: string,
  after = false,
  code = "SQLITE_BUSY",
) {
  const exec = f.db.exec.bind(f.db);
  return vi.spyOn(f.db, "exec").mockImplementation((text) => {
    if (text === sql) {
      if (after) exec(text);
      throw sqlFailure(code);
    }
    return exec(text);
  });
}
function injectRun(
  f: Fixture,
  part: string,
  run: (
    original: (...args: unknown[]) => Database.RunResult,
    args: unknown[],
  ) => Database.RunResult,
) {
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes(part)) return statement;
    return new Proxy(statement, {
      get(target, prop) {
        if (prop === "run")
          return (...args: unknown[]) =>
            run((...a: unknown[]) => target.run(...a), args);
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof f.db.prepare);
}

test("Provider expectation is immutable and derived from supported TOMORROW_IO, not Metadata", () => {
  expect(STARTUP_PROVIDERS).toEqual([TOMORROW_IO]);
  expect(Object.isFrozen(STARTUP_PROVIDERS)).toBe(true);
});
test("H54-19/21 Gen1 -> Gen2 creates parent, UNPROVISIONED Snapshot and RUNNING atomically", () => {
  const f = fixture();
  const order = vi.spyOn(f.db, "exec");
  expect(execute(f)).toEqual({ outcome: "committed", generation: 2 });
  expect(order.mock.calls.map((c) => c[0])).toEqual([
    "BEGIN IMMEDIATE",
    "COMMIT",
  ]);
  expect(f.db.prepare("SELECT * FROM startup_generations").all()).toEqual([
    {
      generation: 2,
      boot_id: boot,
      previous_state: "RUNNING",
      previous_boot_id: boot,
      previous_generation: 1,
    },
  ]);
  expect(
    f.db.prepare("SELECT * FROM startup_provider_boundaries").all(),
  ).toEqual([
    {
      generation: 2,
      provider_key: TOMORROW_IO,
      provider_state: "UNPROVISIONED",
      cutoff_sequence: null,
      history_status_snapshot: null,
      initialized_at_ms_snapshot: null,
      history_fingerprint: historyFingerprint({
        metadata: null,
        consumptions: [],
      }),
    },
  ]);
  expect(f.db.inTransaction).toBe(false);
  expect(connectionCoordination(f.db).busy).toBe(false);
  validateSchema(f.db, 3);
});
for (const count of [0, 1, 3])
  test(`H54-27 PROVISIONED / ${count} records retain all Quota data and Snapshot`, () => {
    const f = fixture();
    provision(f, count);
    const before = snapshot(f);
    expect(execute(f).outcome).toBe("committed");
    const row = f.db
      .prepare("SELECT * FROM startup_provider_boundaries")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      provider_state: "PROVISIONED",
      cutoff_sequence: count,
      history_status_snapshot: "ACTIVE",
      initialized_at_ms_snapshot: 0,
    });
    expect(snapshot(f).provider_quota_consumptions).toEqual(
      before.provider_quota_consumptions,
    );
    expect(snapshot(f).provider_quota_metadata).toEqual(
      before.provider_quota_metadata,
    );
  });
for (const prior of ["RUNNING", "CLEAN"])
  test(`H54-18/29 reconnect after ${prior}, changed OS Boot, continuous Gen2 -> 3 -> 4`, () => {
    let f = gen2(fixture());
    f.db.prepare("UPDATE backend_lifecycle SET state=?").run(prior);
    vi.mocked(readOsBootId).mockReturnValue(nextBoot);
    expect(f.service.execute({ bootId: nextBoot })).toEqual({
      outcome: "committed",
      generation: 3,
    });
    expect(
      f.db
        .prepare("SELECT * FROM startup_generations WHERE generation=3")
        .get(),
    ).toMatchObject({
      previous_state: prior,
      previous_boot_id: boot,
      boot_id: nextBoot,
      previous_generation: 2,
    });
    f = reopen(f);
    expect(f.service.execute({ bootId: nextBoot })).toEqual({
      outcome: "committed",
      generation: 4,
    });
  });
test("Timestamp structure alone permits reversed/future timestamps, without Trust or send capability", () => {
  const f = fixture();
  provision(f);
  f.db.exec(
    "UPDATE provider_quota_consumptions SET reserved_at_ms=CASE sequence WHEN 1 THEN 8640000000000000 ELSE 0 END",
  );
  const result = execute(f);
  expect(result).toEqual({ outcome: "committed", generation: 2 });
  expect(Object.keys(result).sort()).toEqual(["generation", "outcome"]);
});
test("Current status SUSPENDED is preserved, never promoted to ACTIVE", () => {
  const f = fixture();
  provision(f, 0);
  f.db.exec("UPDATE provider_quota_metadata SET history_status='SUSPENDED'");
  expect(execute(f).outcome).toBe("committed");
  expect(
    f.db
      .prepare(
        "SELECT history_status_snapshot FROM startup_provider_boundaries",
      )
      .get(),
  ).toEqual({ history_status_snapshot: "SUSPENDED" });
});
for (const mutation of [
  "INSERT INTO startup_generations VALUES (2,'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee','RUNNING','aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',1)",
  "UPDATE backend_lifecycle SET state='CLEAN'",
])
  test(`Gen1 exception cannot hide abnormal initial state: ${mutation}`, () => {
    const f = fixture();
    f.db.exec(mutation);
    const before = snapshot(f);
    expect(execute(f).outcome).not.toBe("committed");
    expect(snapshot(f)).toEqual(before);
  });
for (const mutation of [
  "DELETE FROM startup_provider_boundaries",
  "UPDATE startup_provider_boundaries SET provider_key='unknown'",
  "UPDATE startup_generations SET boot_id='11111111-2222-3333-4444-555555555555'",
  "UPDATE startup_generations SET previous_state='CLEAN'",
  "UPDATE startup_provider_boundaries SET history_fingerprint=printf('%064d',0)",
  "UPDATE backend_lifecycle SET generation=3",
  "UPDATE startup_generations SET previous_boot_id='00000000-0000-0000-0000-000000000000'",
])
  test(`H54-31 prior history rejected with no fallback/update: ${mutation}`, () => {
    const f = gen2(fixture());
    f.db.exec(mutation);
    const before = snapshot(f);
    expect(execute(f).outcome).not.toBe("committed");
    expect(snapshot(f)).toEqual(before);
  });
test("Gen3 parent previous Boot must equal Gen2 Boot", () => {
  let f = gen2(fixture());
  expect(execute(f).outcome).toBe("committed");
  f = reopen(f);
  f.db
    .prepare(
      "UPDATE startup_generations SET previous_boot_id=? WHERE generation=3",
    )
    .run(nextBoot);
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "startup_chain_mismatch",
  });
});
test("Gen1 boundary residue and FK inconsistency are not ignored", () => {
  const f = fixture();
  f.db.pragma("foreign_keys=OFF");
  f.db
    .prepare(
      "INSERT INTO startup_provider_boundaries VALUES (2,?,'UNPROVISIONED',NULL,NULL,NULL,?)",
    )
    .run(TOMORROW_IO, historyFingerprint({ metadata: null, consumptions: [] }));
  f.db.pragma("foreign_keys=ON");
  expect(execute(f).outcome).not.toBe("committed");
  expect(
    f.db.prepare("SELECT generation FROM backend_lifecycle").get(),
  ).toEqual({ generation: 1 });
});
test("Unknown Provider metadata and history cannot define expected Provider set", () => {
  const f = fixture();
  f.db.exec(
    "INSERT INTO provider_quota_metadata VALUES ('unknown','ACTIVE',0,0)",
  );
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "provider_set_mismatch",
  });
});
for (const change of [
  "DELETE FROM provider_quota_consumptions WHERE sequence=1",
  "UPDATE provider_quota_consumptions SET reserved_at_ms=-1 WHERE sequence=2",
  "UPDATE provider_quota_consumptions SET reserved_at_ms=1.5 WHERE sequence=2",
  "UPDATE provider_quota_consumptions SET reserved_at_ms=9007199254740991 WHERE sequence=2",
  "UPDATE provider_quota_metadata SET initialized_at_ms=-1",
  "UPDATE provider_quota_metadata SET initialized_at_ms=9007199254740991",
  "UPDATE provider_quota_metadata SET last_sequence=3",
])
  test(`H54-27 full Consumption/Metadata structure: ${change}`, () => {
    const f = fixture();
    provision(f);
    f.db.exec(change);
    const before = snapshot(f);
    expect(execute(f).outcome).not.toBe("committed");
    expect(snapshot(f)).toEqual(before);
  });
test("Missing Metadata with existing Consumption is refused even with disabled SQL FK during corruption", () => {
  const f = fixture();
  provision(f);
  f.db.pragma("foreign_keys=OFF");
  f.db.exec("DELETE FROM provider_quota_metadata");
  f.db.pragma("foreign_keys=ON");
  expect(execute(f).outcome).not.toBe("committed");
});
test("D04-R01 cutoff-after corruption now blocks Startup despite matching prior prefix", () => {
  let f = fixture();
  provision(f, 1);
  f = gen2(f);
  f.db.exec(
    "INSERT INTO provider_quota_consumptions VALUES ('tomorrow.io',2,-1);UPDATE provider_quota_metadata SET last_sequence=2",
  );
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "invalid_history_integer",
  });
  expect(
    f.db.prepare("SELECT generation FROM backend_lifecycle").get(),
  ).toEqual({ generation: 2 });
});
test("PROVISIONED zero Snapshot cannot silently become missing current Metadata", () => {
  let f = fixture();
  provision(f, 0);
  f = gen2(f);
  f.db.exec("DELETE FROM provider_quota_metadata");
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "history_regressed",
  });
});
test("Actual prefix mutation refuses prior Fingerprint, without replacing stored Digest", () => {
  let f = fixture();
  provision(f);
  f = gen2(f);
  f.db.exec(
    "UPDATE provider_quota_consumptions SET reserved_at_ms=11 WHERE sequence=1",
  );
  const before = snapshot(f);
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "fingerprint_mismatch",
  });
  expect(snapshot(f)).toEqual(before);
});
test("UNPROVISIONED Snapshot followed by valid F-01-like data creates new PROVISIONED Snapshot without UPDATE", () => {
  const f = gen2(fixture());
  provision(f, 1);
  const old = f.db.prepare("SELECT * FROM startup_provider_boundaries").get();
  expect(execute(f).outcome).toBe("committed");
  expect(
    f.db
      .prepare("SELECT * FROM startup_provider_boundaries WHERE generation=2")
      .get(),
  ).toEqual(old);
  expect(
    f.db
      .prepare(
        "SELECT provider_state,cutoff_sequence FROM startup_provider_boundaries WHERE generation=3",
      )
      .get(),
  ).toEqual({ provider_state: "PROVISIONED", cutoff_sequence: 1 });
});
for (const setting of [
  "journal_mode=DELETE",
  "synchronous=NORMAL",
  "foreign_keys=OFF",
  "user_version=2",
])
  test(`Preflight rejects ${setting} without reconfiguring`, () => {
    const f = fixture();
    f.db.pragma(setting);
    expect(execute(f).outcome).toBe("database_error");
    expect(
      f.db.prepare("SELECT generation FROM backend_lifecycle").get(),
    ).toEqual({ generation: 1 });
  });
for (const value of ["bad", "00000000-0000-0000-0000-000000000000", nextBoot])
  test(`Requested Boot must match actual OS verification: ${value}`, () => {
    const f = fixture();
    expect(f.service.execute({ bootId: value })).toMatchObject({
      outcome: "rejected",
      reason: "os_boot_id_unverified",
    });
  });
test("OS read failure cannot be replaced by request Boot", () => {
  const f = fixture();
  vi.mocked(readOsBootId).mockImplementation(() => {
    throw Error("secret");
  });
  expect(JSON.stringify(execute(f))).not.toContain("secret");
  expect(execute(f).outcome).not.toBe("committed");
});
test("Exclusive Lock is verified before SQL and again inside owned Transaction", () => {
  const f = fixture();
  const calls = vi.spyOn(f.db, "prepare");
  vi.mocked(f.lock.assertHeld).mockImplementation(() => {
    throw Error("lock lost");
  });
  expect(execute(f).outcome).toBe("database_error");
  expect(calls).not.toHaveBeenCalled();
});
test("Lock lost after BEGIN rolls back, no partial writes", () => {
  const f = fixture();
  const before = snapshot(f);
  vi.mocked(f.lock.assertHeld)
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw Error("lock lost");
    });
  expect(execute(f).outcome).toBe("database_error");
  expect(snapshot(f)).toEqual(before);
  expect(f.db.inTransaction).toBe(false);
});
for (const key of ["busy", "connectionUnresolved", "blocked"] as const)
  test(`Shared ${key} prohibits new Transaction`, () => {
    const f = fixture();
    const c = connectionCoordination(f.db);
    if (key === "blocked")
      c.blocked = { scope: "database", layer: "L3", reason: "integrity" };
    else c[key] = true;
    const exec = vi.spyOn(f.db, "exec");
    expect(execute(f).outcome).toBe("database_error");
    expect(exec).not.toHaveBeenCalled();
    if (key === "busy") expect(c.busy).toBe(true);
  });
test("Unowned existing Transaction remains untouched and protects shared Connection", () => {
  const f = fixture();
  f.db.exec("BEGIN");
  const exec = vi.spyOn(f.db, "exec");
  expect(execute(f)).toMatchObject({
    outcome: "database_error",
    reason: "transaction_unresolved",
  });
  expect(exec).not.toHaveBeenCalled();
  expect(f.db.inTransaction).toBe(true);
});
for (const after of [false, true])
  test(`BEGIN ${after ? "after" : "before"} exception: Rollback confirmed, no Startup evidence`, () => {
    const f = fixture();
    const before = snapshot(f);
    execFault(f, "BEGIN IMMEDIATE", after);
    expect(execute(f)).toMatchObject({
      outcome: "database_error",
      layer: "L1",
    });
    expect(f.db.inTransaction).toBe(false);
    expect(snapshot(f)).toEqual(before);
  });
for (const part of [
  "INSERT INTO startup_generations",
  "INSERT INTO startup_provider_boundaries",
])
  test(`${part} failure is atomic rollback`, () => {
    const f = fixture();
    const before = snapshot(f);
    injectRun(f, part, () => {
      throw sqlFailure();
    });
    expect(execute(f)).toMatchObject({
      outcome: "database_error",
      layer: "L1",
    });
    expect(snapshot(f)).toEqual(before);
  });
for (const changes of [0, 2])
  test(`Lifecycle conditional UPDATE reports ${changes} -> rollback all writes`, () => {
    const f = fixture();
    const before = snapshot(f);
    injectRun(f, "UPDATE backend_lifecycle", () => ({
      changes,
      lastInsertRowid: 0,
    }));
    expect(execute(f)).toMatchObject({
      outcome: "rejected",
      reason: "lifecycle_update_mismatch",
    });
    expect(snapshot(f)).toEqual(before);
  });
for (const after of [false, true])
  test(`H54-01 COMMIT ${after ? "after-success" : "before"} throw is never adopted, no same-Connection retry`, () => {
    const f = fixture();
    const before = snapshot(f);
    execFault(f, "COMMIT", after);
    expect(execute(f)).toEqual({
      outcome: "unknown",
      reason: "startup_commit_unknown",
    });
    expect(f.db.inTransaction).toBe(false);
    if (!after) expect(snapshot(f)).toEqual(before);
    else
      expect(
        f.db.prepare("SELECT generation FROM backend_lifecycle").get(),
      ).toEqual({ generation: 2 });
    const exec = vi.spyOn(f.db, "exec");
    exec.mockClear();
    expect(
      new StartupTransactionService(f.db, f.lock).execute({ bootId: boot }),
    ).toMatchObject({
      outcome: "rejected",
      reason: "startup_already_attempted",
    });
    expect(exec).not.toHaveBeenCalled();
  });
test("ROLLBACK failure with unresolved Transaction protects all Repositories", () => {
  const f = fixture();
  injectRun(f, "INSERT INTO startup_provider_boundaries", () => {
    throw sqlFailure();
  });
  execFault(f, "ROLLBACK");
  expect(execute(f)).toMatchObject({
    outcome: "database_error",
    layer: "L4",
    reason: "transaction_unresolved",
  });
  expect(connectionCoordination(f.db)).toMatchObject({
    busy: false,
    connectionUnresolved: true,
    blocked: { layer: "L4" },
  });
  expect(
    new PublishedStateRepository(f.db).save("schedule", "{}").outcome,
  ).not.toBe("saved");
});
test("ROLLBACK after-success fatal throw still blocks Connection even though Transaction ended", () => {
  const f = fixture();
  injectRun(f, "INSERT INTO startup_provider_boundaries", () => {
    throw sqlFailure();
  });
  execFault(f, "ROLLBACK", true, "SQLITE_CORRUPT");
  expect(execute(f)).toMatchObject({ outcome: "database_error", layer: "L3" });
  expect(f.db.inTransaction).toBe(false);
  expect(connectionCoordination(f.db).blocked?.layer).toBe("L3");
});
test("Unreadable Transaction status marks unresolved, no SQL and no retry", () => {
  const f = fixture();
  const proxy = new Proxy(f.db, {
    get(target, key) {
      if (key === "inTransaction") throw Error("secret");
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  expect(
    new StartupTransactionService(proxy, f.lock).execute({ bootId: boot }),
  ).toMatchObject({
    outcome: "database_error",
    layer: "L4",
    reason: "transaction_unresolved",
  });
  expect(connectionCoordination(proxy).connectionUnresolved).toBe(true);
});
test("All validation repeated inside BEGIN: corruption introduced after Preflight is rejected", () => {
  const f = fixture();
  provision(f, 1);
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "BEGIN IMMEDIATE")
      exec("UPDATE provider_quota_consumptions SET reserved_at_ms=-1");
    return r;
  });
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "invalid_history_integer",
  });
  expect(
    f.db
      .prepare("SELECT reserved_at_ms FROM provider_quota_consumptions")
      .get(),
  ).toEqual({ reserved_at_ms: 10 });
});
test("One completed or failed Startup per owned Connection, no implicit retry", () => {
  const f = fixture();
  expect(execute(f).outcome).toBe("committed");
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "startup_already_attempted",
  });
});
test("Restricted v3 facade exposes only Startup execute and remains startupComplete=false", () => {
  const f = fixture();
  f.db.close();
  const h = BackendStore.openV3ForStartup(f.lock);
  handles.push(h);
  expect(Object.keys(h).sort()).toEqual([
    "close",
    "lifecycle",
    "startup",
    "startupComplete",
  ]);
  expect(Object.keys(h.startup)).toEqual(["execute"]);
  expect(Object.isFrozen(h.startup)).toBe(true);
  expect(h.startup.execute({ bootId: boot })).toEqual({
    outcome: "committed",
    generation: 2,
  });
  expect(h.startupComplete).toBe(false);
  expect(h.lifecycle.read()).toMatchObject({
    outcome: "found",
    marker: { generation: 2 },
  });
  expect(h).not.toHaveProperty("quota");
  expect(h).not.toHaveProperty("db");
  expect(h).not.toHaveProperty("send");
});

test("Generation upper bound rejected before any allocation or write", () => {
  const f = fixture();
  f.db
    .prepare("UPDATE backend_lifecycle SET generation=?")
    .run(Number.MAX_SAFE_INTEGER);
  const exec = vi.spyOn(f.db, "exec");
  expect(execute(f)).toEqual({
    outcome: "rejected",
    reason: "generation_exhausted",
  });
  expect(exec).not.toHaveBeenCalled();
});
test("Lock failure cannot roll back an unowned Transaction", () => {
  const f = fixture();
  f.db.exec("BEGIN");
  vi.mocked(f.lock.assertHeld).mockImplementation(() => {
    throw Error("lost");
  });
  const exec = vi.spyOn(f.db, "exec");
  expect(execute(f)).toMatchObject({
    outcome: "database_error",
    reason: "transaction_unresolved",
  });
  expect(exec).not.toHaveBeenCalled();
  expect(f.db.inTransaction).toBe(true);
});
test("Silent Boundary INSERT omission detected before conditional Lifecycle UPDATE", () => {
  const f = fixture();
  const before = snapshot(f);
  injectRun(f, "INSERT INTO startup_provider_boundaries", () => ({
    changes: 0,
    lastInsertRowid: 0,
  }));
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "provider_set_mismatch",
  });
  expect(snapshot(f)).toEqual(before);
});
test("Boundary content replaced on INSERT cannot be accepted even with correct set/count", () => {
  const f = fixture();
  const before = snapshot(f);
  injectRun(f, "INSERT INTO startup_provider_boundaries", (run, args) => {
    const a = [...args];
    a[6] = "0".repeat(64);
    return run(...a);
  });
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "boundary_insert_mismatch",
  });
  expect(snapshot(f)).toEqual(before);
});
test("Duplicate Consumption returned by driver never sorted/deduplicated into valid history", () => {
  const f = fixture();
  provision(f, 1);
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    const statement = prepare(sql);
    if (
      !sql.startsWith(
        "SELECT provider_key,sequence,reserved_at_ms FROM provider_quota_consumptions",
      )
    )
      return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key === "all")
          return () => [
            { provider_key: TOMORROW_IO, sequence: 1n, reserved_at_ms: 10n },
            { provider_key: TOMORROW_IO, sequence: 1n, reserved_at_ms: 10n },
          ];
        if (key === "safeIntegers")
          return () =>
            new Proxy(target, {
              get(t, p) {
                if (p === "all")
                  return () => [
                    {
                      provider_key: TOMORROW_IO,
                      sequence: 1n,
                      reserved_at_ms: 10n,
                    },
                    {
                      provider_key: TOMORROW_IO,
                      sequence: 1n,
                      reserved_at_ms: 10n,
                    },
                  ];
                const v = Reflect.get(t, p, t);
                return typeof v === "function" ? v.bind(t) : v;
              },
            });
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }) as typeof f.db.prepare);
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "invalid_history",
  });
});
test("Unknown Consumption Provider with no Metadata fails closed, not silently filtered", () => {
  const f = fixture();
  f.db.pragma("foreign_keys=OFF");
  f.db.exec("INSERT INTO provider_quota_consumptions VALUES ('unknown',1,0)");
  f.db.pragma("foreign_keys=ON");
  expect(execute(f).outcome).not.toBe("committed");
});
test("Extra Boundary Provider rejects complete latest set rather than ignoring row", () => {
  const f = gen2(fixture());
  f.db
    .prepare(
      "INSERT INTO startup_provider_boundaries VALUES (2,'unknown','UNPROVISIONED',NULL,NULL,NULL,?)",
    )
    .run(historyFingerprint({ metadata: null, consumptions: [] }));
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "boundary_set_mismatch",
  });
});
test("Generation gap and extra future parent cannot be normalized", () => {
  const f = gen2(fixture());
  f.db
    .prepare("INSERT INTO startup_generations VALUES (4,?,'RUNNING',?,3)")
    .run(boot, boot);
  expect(execute(f)).toMatchObject({
    outcome: "rejected",
    reason: "startup_chain_mismatch",
  });
});
test("Uncertain preflight rejection leaves unrelated Published State/Cache unchanged", () => {
  const f = fixture();
  f.db.exec(
    "INSERT INTO published_state_snapshots VALUES ('schedule',1,'{\"data\":null}');INSERT INTO backend_cache VALUES ('schedule','{\"cached\":true}')",
  );
  const before = snapshot(f);
  execFault(f, "COMMIT");
  expect(execute(f).outcome).toBe("unknown");
  expect(snapshot(f)).toEqual(before);
});

for (const change of [
  "INSERT INTO provider_quota_metadata VALUES (NULL,'ACTIVE',0,0)",
  "INSERT INTO provider_quota_metadata VALUES ('','ACTIVE',0,0)",
])
  test(`Invalid Provider key not silently treated as absent: ${change}`, () => {
    const f = fixture();
    f.db.exec(change);
    expect(execute(f)).toMatchObject({
      outcome: "rejected",
      reason: "provider_set_mismatch",
    });
  });
test("Invalid Metadata status rejected independently from DDL CHECK", () => {
  const f = fixture();
  provision(f, 0);
  f.db.pragma("ignore_check_constraints=ON");
  f.db.exec("UPDATE provider_quota_metadata SET history_status='INVALID'");
  f.db.pragma("ignore_check_constraints=OFF");
  expect(execute(f).outcome).not.toBe("committed");
});
test("Fractional/unsafe last_sequence rejected without coercion", () => {
  for (const value of [1.5, 9007199254740992]) {
    const f = fixture();
    provision(f, 0);
    f.db
      .prepare("UPDATE provider_quota_metadata SET last_sequence=?")
      .run(value);
    expect(execute(f)).toMatchObject({
      outcome: "rejected",
      reason: "invalid_history_integer",
    });
  }
});
test("COMMIT status getter failure cannot publish generation even after Commit succeeded", () => {
  const f = fixture();
  let failed = false;
  const exec = f.db.exec.bind(f.db);
  const proxy = new Proxy(f.db, {
    get(target, key) {
      if (key === "inTransaction" && failed) throw Error("private");
      if (key === "exec")
        return (sql: string) => {
          const result = exec(sql);
          if (sql === "COMMIT") failed = true;
          return result;
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  expect(
    new StartupTransactionService(proxy, f.lock).execute({ bootId: boot }),
  ).toMatchObject({
    outcome: "database_error",
    layer: "L4",
    reason: "transaction_unresolved",
  });
  expect(f.db.inTransaction).toBe(false);
  expect(connectionCoordination(proxy)).toMatchObject({
    connectionUnresolved: true,
    blocked: { layer: "L4" },
  });
});
test("Shared L3 failure from fingerprint reader is preserved by Startup owner", () => {
  const f = gen2(fixture());
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.startsWith("SELECT generation,provider_key,provider_state"))
      throw sqlFailure("SQLITE_CORRUPT");
    return prepare(sql);
  }) as typeof f.db.prepare);
  expect(execute(f)).toMatchObject({ outcome: "database_error", layer: "L3" });
  expect(f.db.inTransaction).toBe(false);
  expect(connectionCoordination(f.db).blocked?.layer).toBe("L3");
});
