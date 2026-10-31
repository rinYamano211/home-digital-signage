import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { configureDatabase } from "../../src/backend/storage/store.js";
import {
  PublishedStateRepository,
  STATE_KEYS,
} from "../../src/backend/storage/published-state-repository.js";

const resources: { db: Database.Database; dir: string }[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "signage-txp-"));
  const db = new Database(join(dir, "test.db"));
  resources.push({ db, dir });
  configureDatabase(db);
  initializeSchema(db);
  return { db, repo: new PublishedStateRepository(db) };
}
afterEach(() => {
  vi.restoreAllMocks();
  const opened = resources.splice(0);
  for (const { db } of opened) if (db.open) db.close();
  for (const { dir } of opened) rmSync(dir, { recursive: true, force: true });
});
const json = (label: unknown) =>
  JSON.stringify({
    data: { label },
    meta: { publishedAt: "2026-10-25T00:00:00Z" },
  });
function rows(db: Database.Database, state = "schedule") {
  return db
    .prepare(
      "SELECT generation,snapshot_json FROM published_state_snapshots WHERE state_key=? ORDER BY generation DESC",
    )
    .safeIntegers(true)
    .all(state);
}
function counter(db: Database.Database, state = "schedule") {
  return db
    .prepare(
      "SELECT last_generation FROM state_generation_counters WHERE state_key=?",
    )
    .safeIntegers(true)
    .get(state);
}
function seed(
  db: Database.Database,
  c: unknown,
  generations: unknown[] = [],
  state = "schedule",
) {
  if (c !== null)
    db.prepare("INSERT INTO state_generation_counters VALUES (?,?)").run(
      state,
      c,
    );
  for (const generation of generations)
    db.prepare("INSERT INTO published_state_snapshots VALUES (?,?,?)").run(
      state,
      generation,
      json(String(generation)),
    );
}
const sqlFailure = () =>
  Object.assign(new Error("sensitive Snapshot must not escape"), {
    code: "SQLITE_BUSY",
  });
function commitFault(
  db: Database.Database,
  after: boolean,
  changed?: () => void,
) {
  const exec = db.exec.bind(db);
  let notified = false;
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" && !notified) {
      notified = true;
      if (after) exec(sql);
      changed?.();
      throw sqlFailure();
    }
    return exec(sql);
  });
}

test("first publish initializes Counter and preserves exact JSON bytes", () => {
  const { db, repo } = fixture();
  const snapshot = ' { "data":null,"meta":{} } ';
  expect(repo.save("schedule", snapshot)).toEqual({
    outcome: "saved",
    generation: 1,
    snapshotJson: snapshot,
    reconciled: false,
  });
  expect(counter(db)).toEqual({ last_generation: 1n });
  expect(rows(db)).toEqual([{ generation: 1n, snapshot_json: snapshot }]);
});
test("consecutive saves retain only newest plus previous and never reduce Counter", () => {
  const { db, repo } = fixture();
  for (let generation = 1; generation <= 5; generation++)
    expect(repo.save("schedule", json(generation))).toMatchObject({
      outcome: "saved",
      generation,
    });
  expect(rows(db)).toEqual([
    { generation: 5n, snapshot_json: json(5) },
    { generation: 4n, snapshot_json: json(4) },
  ]);
  expect(counter(db)).toEqual({ last_generation: 5n });
});
test("all five allowed States have independent generations and pruning", () => {
  const { db, repo } = fixture();
  for (const state of STATE_KEYS)
    expect(repo.save(state, json(state))).toMatchObject({
      outcome: "saved",
      generation: 1,
    });
  repo.save("schedule", json(2));
  repo.save("schedule", json(3));
  for (const state of STATE_KEYS.filter((s) => s !== "schedule"))
    expect(rows(db, state)).toEqual([
      { generation: 1n, snapshot_json: json(state) },
    ]);
});
test("counter-only history and Counter greater than existing Snapshot survive", () => {
  const { db, repo } = fixture();
  seed(db, 40);
  expect(repo.save("schedule", json(41))).toMatchObject({
    outcome: "saved",
    generation: 41,
  });
  db.prepare(
    "UPDATE state_generation_counters SET last_generation=100 WHERE state_key='schedule'",
  ).run();
  expect(repo.save("schedule", json(101))).toMatchObject({
    outcome: "saved",
    generation: 101,
  });
  expect(rows(db)).toEqual([
    { generation: 101n, snapshot_json: json(101) },
    { generation: 41n, snapshot_json: json(41) },
  ]);
});
test.each(["", "photo", "Schedule", "__proto__"])(
  "rejects unsupported key %s before DB work",
  (state) => {
    const { db, repo } = fixture();
    const prepare = vi.spyOn(db, "prepare");
    const exec = vi.spyOn(db, "exec");
    exec.mockClear();
    expect(repo.save(state, json(1))).toMatchObject({
      outcome: "not_saved",
      scope: "input",
      reason: "unsupported_state",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  },
);
test("candidate JSON validation precedes Transaction and is safe in errors", () => {
  const { db, repo } = fixture();
  const exec = vi.spyOn(db, "exec");
  exec.mockClear();
  const result = repo.save("schedule", "secret invalid JSON");
  expect(result).toMatchObject({ outcome: "not_saved", scope: "input" });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(exec).not.toHaveBeenCalled();
});
test.each([null, 1])(
  "Snapshot with missing/behind Counter %s isolates only that State",
  (c) => {
    const { db, repo } = fixture();
    seed(db, c, [2]);
    const prior = rows(db);
    expect(repo.save("schedule", json(3))).toMatchObject({
      outcome: "not_saved",
      scope: "state",
      reason: "counter_inconsistent",
    });
    expect(repo.save("schedule", json(3))).toMatchObject({
      outcome: "not_saved",
      scope: "state",
    });
    expect(rows(db)).toEqual(prior);
    expect(counter(db)).toEqual(
      c === null ? undefined : { last_generation: BigInt(c) },
    );
    expect(repo.save("currentWeather", json(1))).toMatchObject({
      outcome: "saved",
      generation: 1,
    });
  },
);
test("Counter isolation is lifted only after actual integrity recheck, without repair", () => {
  const { db, repo } = fixture();
  seed(db, null, [2]);
  expect(repo.save("schedule", json(3))).toMatchObject({ scope: "state" });
  db.prepare(
    "INSERT INTO state_generation_counters VALUES ('schedule',2)",
  ).run();
  expect(repo.save("schedule", json(3))).toMatchObject({
    outcome: "saved",
    generation: 3,
  });
});
test.each([9007199254740992n, 9223372036854775807n, 1.5, "not an integer"])(
  "rejects unsafe Counter %s before rounding",
  (value) => {
    const { db, repo } = fixture();
    seed(db, value);
    expect(repo.save("schedule", json(1))).toMatchObject({
      outcome: "not_saved",
      scope: "state",
      reason: "integer_out_of_range",
    });
    expect(rows(db)).toEqual([]);
    expect(repo.save("currentWeather", json(1))).toMatchObject({
      outcome: "saved",
      generation: 1,
    });
  },
);
test.each([9007199254740992n, 9223372036854775807n, 1.5])(
  "rejects unsafe Snapshot Generation %s",
  (value) => {
    const { db, repo } = fixture();
    seed(db, Number.MAX_SAFE_INTEGER, [value]);
    expect(repo.save("schedule", json(1))).toMatchObject({
      outcome: "not_saved",
      scope: "state",
      reason: "integer_out_of_range",
    });
    expect(repo.save("currentWeather", json(1))).toMatchObject({
      outcome: "saved",
      generation: 1,
    });
  },
);
test("last safe Generation succeeds once, then stops without reset or wrap", () => {
  const { db, repo } = fixture();
  seed(db, BigInt(Number.MAX_SAFE_INTEGER) - 1n);
  expect(repo.save("schedule", json(1))).toMatchObject({
    outcome: "saved",
    generation: Number.MAX_SAFE_INTEGER,
  });
  expect(repo.save("schedule", json(2))).toMatchObject({
    outcome: "not_saved",
    scope: "state",
    reason: "generation_exhausted",
  });
  expect(counter(db)).toEqual({
    last_generation: BigInt(Number.MAX_SAFE_INTEGER),
  });
  expect(repo.save("currentWeather", json(1))).toMatchObject({
    outcome: "saved",
    generation: 1,
  });
});
test.each([
  "INSERT INTO state_generation_counters",
  "INSERT INTO published_state_snapshots",
  "DELETE FROM published_state_snapshots",
])("failure at %s leaves no partial first publication", (step) => {
  const { db, repo } = fixture();
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith(step)) throw sqlFailure();
    return prepare(sql);
  });
  expect(repo.save("schedule", json(1))).toMatchObject({
    outcome: "not_saved",
  });
  expect(db.inTransaction).toBe(false);
  expect(counter(db)).toBeUndefined();
  expect(rows(db)).toEqual([]);
});
test("DELETE failure rolls back Counter/INSERT and preserves both old generations", () => {
  const { db, repo } = fixture();
  seed(db, 4, [4, 3]);
  const before = rows(db);
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("DELETE FROM")) throw sqlFailure();
    return prepare(sql);
  });
  expect(repo.save("schedule", json(5))).toMatchObject({
    outcome: "not_saved",
  });
  expect(rows(db)).toEqual(before);
  expect(counter(db)).toEqual({ last_generation: 4n });
});
test("failed Commit with successful Rollback is confirmed not saved", () => {
  const { db, repo } = fixture();
  seed(db, 2, [2, 1]);
  const before = rows(db);
  commitFault(db, false);
  expect(repo.save("schedule", json(3))).toMatchObject({
    outcome: "not_saved",
    scope: "database",
    layer: "L1",
  });
  expect(rows(db)).toEqual(before);
  expect(counter(db)).toEqual({ last_generation: 2n });
  expect(repo.save("schedule", json(3))).toMatchObject({
    outcome: "saved",
    generation: 3,
  });
});
test("Commit success then exception reconciles full retention and never replays", () => {
  const { db, repo } = fixture();
  seed(db, 2, [2, 1]);
  commitFault(db, true);
  const prepare = vi.spyOn(db, "prepare");
  expect(repo.save("schedule", json(3))).toEqual({
    outcome: "saved",
    generation: 3,
    snapshotJson: json(3),
    reconciled: true,
  });
  expect(rows(db)).toEqual([
    { generation: 3n, snapshot_json: json(3) },
    { generation: 2n, snapshot_json: json("2") },
  ]);
  expect(
    prepare.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT INTO published_state_snapshots"),
    ),
  ).toHaveLength(1);
  expect(repo.save("hourlyWeather", json(1))).toMatchObject({
    outcome: "saved",
    generation: 1,
  });
});
test.each([
  "extra old",
  "lost previous",
  "changed previous",
  "wrong candidate",
  "wrong Counter",
])("partial Commit match (%s) is unknown and not published", (fault) => {
  const { db, repo } = fixture();
  seed(db, 2, [2, 1]);
  commitFault(db, true, () => {
    if (fault === "extra old")
      db.prepare(
        "INSERT INTO published_state_snapshots VALUES ('schedule',1,?)",
      ).run(json("1"));
    if (fault === "lost previous")
      db.exec("DELETE FROM published_state_snapshots WHERE generation=2");
    if (fault === "changed previous")
      db.exec(
        "UPDATE published_state_snapshots SET snapshot_json='different' WHERE generation=2",
      );
    if (fault === "wrong candidate")
      db.exec(
        "UPDATE published_state_snapshots SET snapshot_json='different' WHERE generation=3",
      );
    if (fault === "wrong Counter")
      db.exec("UPDATE state_generation_counters SET last_generation=4");
  });
  expect(repo.save("schedule", json(3))).toMatchObject({
    outcome: "unknown",
    scope: "state",
  });
  const exec = vi.spyOn(db, "exec");
  exec.mockClear();
  expect(
    new PublishedStateRepository(db).save("schedule", json(4)),
  ).toMatchObject({ outcome: "unknown", reason: "unresolved_save" });
  expect(exec).not.toHaveBeenCalled();
  expect(repo.save("weeklyWeather", json(1))).toMatchObject({
    outcome: "saved",
    generation: 1,
  });
});
test.each([true, false])(
  "unreadable reconciliation after commit=%s stays closed until explicit comparison",
  (committed) => {
    const { db, repo } = fixture();
    seed(db, 2, [2, 1]);
    let rejectRead = false;
    commitFault(db, committed, () => {
      rejectRead = true;
    });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (rejectRead && sql.startsWith("SELECT last_generation"))
        throw sqlFailure();
      return prepare(sql);
    });
    expect(repo.save("schedule", json(3))).toMatchObject({
      outcome: "unknown",
    });
    expect(repo.save("schedule", json(3))).toMatchObject({
      outcome: "unknown",
      reason: "unresolved_save",
    });
    rejectRead = false;
    expect(repo.save("rainForecast", json(1))).toMatchObject({
      outcome: "saved",
      generation: 1,
    });
    const reconciled = repo.reconcile("schedule");
    expect(reconciled).toMatchObject({
      outcome: committed ? "saved" : "not_saved",
    });
    if (!committed)
      expect(reconciled).toMatchObject({
        scope: "database",
        layer: "L1",
        reason: "temporary_sql",
      });
    expect(counter(db)).toEqual({ last_generation: committed ? 3n : 2n });
  },
);
test("Rollback failure halts the entire shared Connection, even through another Repository", () => {
  const { db, repo } = fixture();
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" || sql === "ROLLBACK") throw sqlFailure();
    return exec(sql);
  });
  expect(repo.save("schedule", json(1))).toMatchObject({
    outcome: "unknown",
    scope: "database",
    reason: "transaction_unresolved",
  });
  const prepare = vi.spyOn(db, "prepare");
  prepare.mockClear();
  expect(
    new PublishedStateRepository(db).save("weeklyWeather", json(1)),
  ).toMatchObject({ outcome: "unknown", scope: "database" });
  expect(prepare).not.toHaveBeenCalled();
  expect(repo.reconcile("schedule")).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
});
test("State integrity failure during reconciliation holds only that State", () => {
  const { db, repo } = fixture();
  seed(db, 2, [2, 1]);
  commitFault(db, true, () => {
    db.exec(
      "UPDATE state_generation_counters SET last_generation=1 WHERE state_key='schedule'",
    );
  });
  expect(repo.save("schedule", json(3))).toMatchObject({
    outcome: "unknown",
    scope: "state",
    reason: "reconciliation_failed",
  });
  expect(db.inTransaction).toBe(false);
  const another = new PublishedStateRepository(db);
  expect(another.save("schedule", json(4))).toMatchObject({
    outcome: "unknown",
    reason: "unresolved_save",
  });
  expect(another.save("currentWeather", json(1))).toMatchObject({
    outcome: "saved",
    generation: 1,
  });
  expect(counter(db)).toEqual({ last_generation: 1n });
});
test("DB corruption-equivalent failure during reconciliation blocks other States", () => {
  const { db, repo } = fixture();
  let reconciling = false;
  commitFault(db, true, () => {
    reconciling = true;
  });
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (reconciling && sql.startsWith("SELECT last_generation")) {
      reconciling = false;
      throw Object.assign(new Error("synthetic reconciliation corruption"), {
        code: "SQLITE_CORRUPT",
      });
    }
    return prepare(sql);
  });
  expect(repo.save("schedule", json(1))).toMatchObject({
    outcome: "unknown",
    scope: "database",
    reason: "reconciliation_failed",
  });
  expect(db.inTransaction).toBe(false);
  spy.mockClear();
  expect(
    new PublishedStateRepository(db).save("currentWeather", json(1)),
  ).toMatchObject({
    outcome: "not_saved",
    scope: "database",
    layer: "L3",
  });
  expect(spy).not.toHaveBeenCalled();
});
test("pre-existing Transaction is neither joined nor rolled back", () => {
  const { db, repo } = fixture();
  db.exec("BEGIN");
  expect(repo.save("schedule", json(1))).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
  expect(db.inTransaction).toBe(true);
});
test.each(["missing", "incompatible"])(
  "Counter Table %s blocks the whole DB",
  (fault) => {
    const { db, repo } = fixture();
    db.exec("DROP TABLE state_generation_counters");
    if (fault === "incompatible")
      db.exec(
        "CREATE TABLE state_generation_counters(state_key TEXT,last_generation INTEGER)",
      );
    expect(repo.save("schedule", json(1))).toMatchObject({
      outcome: "not_saved",
      scope: "database",
      layer: "L3",
    });
    expect(repo.save("currentWeather", json(1))).toMatchObject({
      outcome: "not_saved",
      scope: "database",
      layer: "L3",
    });
    const prepare = vi.spyOn(db, "prepare");
    prepare.mockClear();
    expect(
      new PublishedStateRepository(db).save("hourlyWeather", json(1)),
    ).toMatchObject({ outcome: "not_saved", scope: "database", layer: "L3" });
    expect(prepare).not.toHaveBeenCalled();
  },
);

test("real State-specific NOT NULL violation rolls back and leaves other States writable", () => {
  const { db, repo } = fixture();
  seed(db, 2, [2, 1]);
  const before = rows(db);
  const prepare = db.prepare.bind(db);
  let nativeCode: string | undefined;
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("INSERT INTO published_state_snapshots")) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...parameters) => {
        if (parameters[0] !== "schedule") return run(...parameters);
        try {
          // Execute the real SQLite statement with one invalid State's value;
          // the canonical schema is unchanged, unlike adding a trigger.
          return run(parameters[0], parameters[1], null);
        } catch (error) {
          nativeCode = (error as { code?: string }).code;
          throw error;
        }
      });
    }
    return statement;
  });
  expect(repo.save("schedule", json(3))).toMatchObject({
    outcome: "not_saved",
    scope: "state",
    layer: "L3",
    reason: "write_constraint",
  });
  expect(nativeCode).toBe("SQLITE_CONSTRAINT_NOTNULL");
  expect(db.inTransaction).toBe(false);
  expect(counter(db)).toEqual({ last_generation: 2n });
  expect(rows(db)).toEqual(before);
  expect(
    new PublishedStateRepository(db).save("currentWeather", json(1)),
  ).toMatchObject({ outcome: "saved", generation: 1 });
  expect(rows(db, "currentWeather")).toHaveLength(1);
});

test("real SQLITE_BUSY is L1 and allows another State after writer releases Transaction", () => {
  const { db, repo } = fixture();
  const blocker = new Database(db.name);
  try {
    db.pragma("busy_timeout=0");
    blocker.exec("BEGIN IMMEDIATE");
    expect(repo.save("schedule", json(1))).toMatchObject({
      outcome: "not_saved",
      scope: "database",
      layer: "L1",
      reason: "temporary_sql",
    });
    expect(db.inTransaction).toBe(false);
    expect(rows(db)).toEqual([]);
    expect(counter(db)).toBeUndefined();
    blocker.exec("ROLLBACK");
    expect(
      new PublishedStateRepository(db).save("currentWeather", json(1)),
    ).toMatchObject({ outcome: "saved", generation: 1 });
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK");
    blocker.close();
  }
});

test("real SQLITE_READONLY is L2 and does not permanently block a resolved Connection", () => {
  const { db, repo } = fixture();
  seed(db, 2, [2, 1]);
  const before = rows(db);
  db.pragma("query_only=ON");
  expect(repo.save("schedule", json(3))).toMatchObject({
    outcome: "not_saved",
    scope: "database",
    layer: "L2",
    reason: "database_unavailable",
  });
  expect(db.inTransaction).toBe(false);
  expect(rows(db)).toEqual(before);
  expect(counter(db)).toEqual({ last_generation: 2n });
  db.pragma("query_only=OFF");
  expect(
    new PublishedStateRepository(db).save("currentWeather", json(1)),
  ).toMatchObject({ outcome: "saved", generation: 1 });
});

test.each(["SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_IOERR"])(
  "%s injection keeps DB-wide failures closed after Rollback resolves",
  (code) => {
    const { db, repo } = fixture();
    seed(db, 2, [2, 1]);
    const before = rows(db);
    const prepare = db.prepare.bind(db);
    let inject = true;
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (inject && sql.startsWith("INSERT INTO published_state_snapshots")) {
        inject = false;
        // Corruption/storage-equivalent fault injection, not real file damage.
        throw Object.assign(new Error("synthetic storage failure"), { code });
      }
      return prepare(sql);
    });
    expect(repo.save("schedule", json(3))).toMatchObject({
      outcome: "not_saved",
      scope: "database",
      layer: code === "SQLITE_IOERR" ? "L4" : "L3",
    });
    expect(db.inTransaction).toBe(false);
    expect(counter(db)).toEqual({ last_generation: 2n });
    expect(rows(db)).toEqual(before);
    spy.mockClear();
    expect(
      new PublishedStateRepository(db).save("currentWeather", json(1)),
    ).toMatchObject({ outcome: "not_saved", scope: "database" });
    expect(spy).not.toHaveBeenCalled();
  },
);

test("sync saves serialize concurrent callers and refuse reentrant writes", async () => {
  const { db, repo } = fixture();
  const generations = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => repo.save("schedule", json(i))),
    ),
  );
  expect(
    generations.map((result) =>
      result.outcome === "saved" ? result.generation : null,
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const exec = db.exec.bind(db);
  let nested: unknown;
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "BEGIN IMMEDIATE")
      nested = new PublishedStateRepository(db).save("currentWeather", json(1));
    return exec(sql);
  });
  expect(repo.save("schedule", json(11))).toMatchObject({
    outcome: "saved",
    generation: 11,
  });
  expect(nested).toMatchObject({
    outcome: "not_saved",
    reason: "connection_busy",
  });
});
test("Tx-P leaves Cache, Acquisition Control, Schema and Version unchanged", () => {
  const { db, repo } = fixture();
  db.exec(
    "INSERT INTO backend_cache VALUES ('schedule','cache');INSERT INTO acquisition_control VALUES ('schedule','control')",
  );
  const schema = db.prepare("SELECT * FROM sqlite_schema").all();
  repo.save("schedule", json(1));
  expect(db.prepare("SELECT * FROM backend_cache").all()).toEqual([
    { state_key: "schedule", cache_json: "cache" },
  ]);
  expect(db.prepare("SELECT * FROM acquisition_control").all()).toEqual([
    { state_key: "schedule", control_json: "control" },
  ]);
  expect(db.prepare("SELECT * FROM sqlite_schema").all()).toEqual(schema);
  expect(db.pragma("user_version", { simple: true })).toBe(2);
});
test("saved generations persist after actual Connection close/reopen", () => {
  const { db, repo } = fixture();
  const name = db.name;
  repo.save("schedule", json(1));
  db.close();
  const reopened = new Database(name);
  resources.push({
    db: reopened,
    dir: mkdtempSync(join(tmpdir(), "signage-empty-")),
  });
  expect(
    new PublishedStateRepository(reopened).save("schedule", json(2)),
  ).toMatchObject({ outcome: "saved", generation: 2 });
});

test("generic notification after successful Commit does not leave a false DB block", () => {
  const { db, repo } = fixture();
  const exec = db.exec.bind(db);
  let once = true;
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "COMMIT" && once) {
      once = false;
      throw new Error("unknown notification");
    }
    return result;
  });
  expect(repo.save("schedule", json(1))).toMatchObject({
    outcome: "saved",
    reconciled: true,
  });
  expect(repo.save("currentWeather", json(1))).toMatchObject({
    outcome: "saved",
  });
});
test("unreadable Transaction flag prevents all States from touching the Connection", () => {
  const { db } = fixture();
  // Test-only wrapper of the real Connection, since native getters are non-configurable.
  const uncertain = new Proxy(db, {
    get(target, property) {
      if (property === "inTransaction")
        throw new Error("unknown transaction state");
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const repo = new PublishedStateRepository(uncertain);
  expect(repo.save("schedule", json(1))).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
  const prepare = vi.spyOn(db, "prepare");
  expect(
    new PublishedStateRepository(uncertain).save("currentWeather", json(1)),
  ).toMatchObject({ outcome: "unknown", scope: "database" });
  expect(prepare).not.toHaveBeenCalled();
});

test("reconciliation rejects before-image content changes even when not saved Counter matches", () => {
  const { db, repo } = fixture();
  seed(db, 2, [2, 1]);
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT") throw sqlFailure();
    const result = exec(sql);
    if (sql === "ROLLBACK")
      exec(
        "UPDATE published_state_snapshots SET snapshot_json='changed' WHERE generation=1",
      );
    return result;
  });
  expect(repo.save("schedule", json(3))).toMatchObject({ outcome: "unknown" });
});
test("new first publication after Commit notification compares absent Counter correctly", () => {
  const { db, repo } = fixture();
  commitFault(db, true);
  expect(repo.save("schedule", json(1))).toMatchObject({
    outcome: "saved",
    generation: 1,
    reconciled: true,
  });
});

test("negative Counter and nonpositive Generation are rejected even if CHECK was bypassed", () => {
  const first = fixture();
  first.db.pragma("ignore_check_constraints=ON");
  seed(first.db, -1);
  first.db.pragma("ignore_check_constraints=OFF");
  expect(first.repo.save("schedule", json(1))).toMatchObject({
    outcome: "not_saved",
    scope: "state",
    reason: "integer_out_of_range",
  });
  const second = fixture();
  second.db.pragma("ignore_check_constraints=ON");
  seed(second.db, 1, [0]);
  second.db.pragma("ignore_check_constraints=OFF");
  expect(second.repo.save("schedule", json(1))).toMatchObject({
    outcome: "not_saved",
    scope: "state",
    reason: "integer_out_of_range",
  });
});
