import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { configureDatabase } from "../../src/backend/storage/store.js";
import {
  PublishedStateRepository,
  type SnapshotValidator,
  type ReadEvidence,
  type ConditionalSaveRequest,
} from "../../src/backend/storage/published-state-repository.js";

interface Sample {
  data: { value: number };
  meta: { publishedAt: string; expiresAt: string };
}
const json = (value: number) =>
  JSON.stringify({
    data: { value },
    meta: {
      publishedAt: "2026-10-25T00:00:00Z",
      expiresAt: "2020-01-01T00:00:00Z",
    },
  });
const validator: SnapshotValidator<Sample> = {
  schema(value) {
    const candidate = value as Sample | null;
    return candidate &&
      typeof candidate.data?.value === "number" &&
      typeof candidate.meta?.expiresAt === "string"
      ? { valid: true, value: candidate }
      : { valid: false, reason: "wrong_schema" };
  },
  semantic(value) {
    return value.data.value >= 0
      ? { valid: true, value }
      : { valid: false, reason: "negative_value" };
  },
};
const databases: Database.Database[] = [];
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "signage-read-"));
  dirs.push(dir);
  const db = new Database(join(dir, "test.db"));
  databases.push(db);
  configureDatabase(db);
  initializeSchema(db);
  const logger = { warn: vi.fn(), error: vi.fn() };
  return { db, repo: new PublishedStateRepository(db, logger), logger };
}
function secondary(name: string) {
  const db = new Database(name, { fileMustExist: true });
  databases.push(db);
  return db;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function seed(
  db: Database.Database,
  latest = "{",
  previous: string | null = json(1),
  counter: number | bigint | null = 2,
  state = "schedule",
) {
  if (counter !== null)
    db.prepare("INSERT INTO state_generation_counters VALUES (?,?)").run(
      state,
      counter,
    );
  if (previous !== null)
    db.prepare("INSERT INTO published_state_snapshots VALUES (?,1,?)").run(
      state,
      previous,
    );
  db.prepare("INSERT INTO published_state_snapshots VALUES (?,2,?)").run(
    state,
    latest,
  );
}
function image(db: Database.Database) {
  return {
    counter: db
      .prepare("SELECT * FROM state_generation_counters ORDER BY state_key")
      .safeIntegers(true)
      .all(),
    snapshots: db
      .prepare(
        "SELECT * FROM published_state_snapshots ORDER BY state_key,generation",
      )
      .safeIntegers(true)
      .all(),
  };
}
function evidence(repo: PublishedStateRepository): ReadEvidence {
  const result = repo.read("schedule", validator);
  expect(result.outcome).toBe("previous");
  if (result.outcome !== "previous") throw new Error("Expected previous");
  return result.evidence;
}
function request(token: ReadEvidence): ConditionalSaveRequest {
  return {
    stateKey: "schedule",
    snapshotJson: json(3),
    evidence: token,
    adoption: { outcome: "newer" },
  };
}
const sqlFailure = () =>
  Object.assign(new Error("secret SQLite detail"), { code: "SQLITE_BUSY" });
function commitFault(db: Database.Database, after: boolean, hook?: () => void) {
  const exec = db.exec.bind(db);
  let notified = false;
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" && !notified) {
      notified = true;
      if (after) exec(sql);
      hook?.();
      throw sqlFailure();
    }
    return exec(sql);
  });
}

test("I-01 Read validates JSON then Schema then Semantic outside the Read Transaction", () => {
  const { db, repo } = fixture();
  seed(db, json(2));
  const order: string[] = [];
  const wrapped: SnapshotValidator<Sample> = {
    schema(v) {
      expect(db.inTransaction).toBe(false);
      order.push("schema");
      return validator.schema(v);
    },
    semantic(v) {
      expect(db.inTransaction).toBe(false);
      order.push("semantic");
      return validator.semantic(v);
    },
  };
  expect(repo.read("schedule", wrapped)).toMatchObject({
    outcome: "latest",
    generation: 2,
  });
  expect(order).toEqual(["schema", "semantic"]);
});
test.each([
  ["{", "json_parse", "invalid_json"],
  ["{}", "schema", "wrong_schema"],
  [json(-1), "semantic", "negative_value"],
])(
  "I-01/I-04 latest %s fails at %s, previous gets an opaque token",
  (latest, stage, reason) => {
    const { db, repo, logger } = fixture();
    seed(db, latest);
    const result = repo.read("schedule", validator);
    expect(result).toMatchObject({
      outcome: "previous",
      generation: 1,
      latestInvalid: { generation: 2, stage, reason },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stage }),
      expect.any(String),
    );
    if (result.outcome !== "previous") throw new Error();
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Reflect.ownKeys(result.evidence)).toEqual([]);
  },
);
test.each(["schema", "semantic"] as const)(
  "I-02 %s exception is validator_error with no Fallback or evidence",
  (stage) => {
    const { db, repo, logger } = fixture();
    seed(db, json(2));
    const semantic = vi.fn(validator.semantic);
    const wrapped: SnapshotValidator<Sample> = {
      schema: validator.schema,
      semantic,
    };
    wrapped[stage] = () => {
      throw new TypeError("access_token=secret snapshot");
    };
    const result = repo.read("schedule", wrapped);
    expect(result).toEqual({
      outcome: "validator_error",
      stage,
      reason: "validator_threw_or_invalid_result",
    });
    expect(result).not.toHaveProperty("evidence");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret");
    if (stage === "schema") expect(semantic).not.toHaveBeenCalled();
    expect(repo.read("schedule", validator).outcome).toBe("latest");
  },
);
test.each(["schema", "semantic"] as const)(
  "I-02 previous %s exception also returns validator_error, not isolated",
  (stage) => {
    const { db, repo } = fixture();
    seed(db);
    const wrapped = { ...validator };
    wrapped[stage] = () => {
      throw new Error("unexpected");
    };
    expect(repo.read("schedule", wrapped)).toMatchObject({
      outcome: "validator_error",
      stage,
    });
    expect(repo.read("schedule", validator).outcome).toBe("previous");
  },
);
test("I-02 malformed asynchronous Validator results are validator_error", () => {
  const { db, repo } = fixture();
  seed(db, json(2));
  const asynchronous = {
    schema: () => Promise.resolve({ valid: true, value: {} }),
    semantic: validator.semantic,
  } as unknown as SnapshotValidator<Sample>;
  expect(repo.read("schedule", asynchronous)).toMatchObject({
    outcome: "validator_error",
    stage: "schema",
  });
});
test("I-03 expired normal latest stays latest, does not issue evidence or mutate Metadata", () => {
  const { db, repo } = fixture();
  seed(db, json(2));
  const before = image(db);
  const result = repo.read("schedule", validator);
  expect(result).toEqual({
    outcome: "latest",
    generation: 2,
    snapshot: JSON.parse(json(2)),
  });
  expect(result).not.toHaveProperty("evidence");
  expect(image(db)).toEqual(before);
});
test("I-05 both generations invalid stay isolated until integrity re-Read succeeds", () => {
  const { db, repo } = fixture();
  seed(db, "{", "{}");
  const before = image(db);
  expect(repo.read("schedule", validator)).toEqual({
    outcome: "isolated",
    reason: "no_valid_snapshot",
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2035-01-01"));
  expect(repo.read("schedule", validator).outcome).toBe("isolated");
  expect(image(db)).toEqual(before);
  db.prepare(
    "UPDATE published_state_snapshots SET snapshot_json=? WHERE generation=2",
  ).run(json(2));
  expect(repo.read("schedule", validator).outcome).toBe("latest");
});
test("I-05 invalid sole Snapshot cannot produce a previous candidate", () => {
  const { db, repo } = fixture();
  seed(db, "{", null);
  expect(repo.read("schedule", validator)).toMatchObject({
    outcome: "isolated",
  });
});
test.each([null, 1, 9007199254740992n])(
  "I-06 unsafe Counter %s forbids all Validator calls and Fallback",
  (counter) => {
    const { db, repo } = fixture();
    seed(db, "{", json(1), counter);
    const schema = vi.fn(validator.schema);
    const result = repo.read("schedule", { ...validator, schema });
    expect(result.outcome).toBe("isolated");
    expect(result).not.toHaveProperty("evidence");
    expect(schema).not.toHaveBeenCalled();
  },
);
test("I-07 actual WAL writer between Counter/Snapshot reads cannot tear a Read image", () => {
  const { db, repo } = fixture();
  seed(db, json(2));
  const writer = secondary(db.name);
  const prepare = db.prepare.bind(db);
  let injected = false;
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("SELECT generation,") && !injected) {
      injected = true;
      writer.exec(
        "BEGIN IMMEDIATE;UPDATE state_generation_counters SET last_generation=3 WHERE state_key='schedule'",
      );
      writer
        .prepare(
          "INSERT INTO published_state_snapshots VALUES ('schedule',3,?)",
        )
        .run(json(3));
      writer.exec("COMMIT");
    }
    return prepare(sql);
  });
  expect(repo.read("schedule", validator)).toMatchObject({
    outcome: "latest",
    generation: 2,
    snapshot: { data: { value: 2 } },
  });
  expect(repo.read("schedule", validator)).toMatchObject({
    outcome: "latest",
    generation: 3,
  });
});
test("I-07 Validator cannot reenter the shared Repository Connection", () => {
  const { db, repo, logger } = fixture();
  seed(db, json(2));
  const other = new PublishedStateRepository(db, logger);
  const wrapped: SnapshotValidator<Sample> = {
    ...validator,
    schema(value) {
      expect(db.inTransaction).toBe(false);
      expect(other.read("schedule", validator)).toMatchObject({
        outcome: "database_error",
        reason: "connection_busy",
      });
      expect(other.save("currentWeather", json(4))).toMatchObject({
        outcome: "not_saved",
        reason: "connection_busy",
      });
      return validator.schema(value);
    },
  };
  expect(repo.read("schedule", wrapped).outcome).toBe("latest");
  expect(
    db.prepare("SELECT state_key FROM state_generation_counters").all(),
  ).toEqual([{ state_key: "schedule" }]);
});
test.each(["forged", "copy", "proxy", "latest", "empty"])(
  "I-08 %s cannot authorize conditional save",
  (kind) => {
    const { db, repo } = fixture();
    seed(db);
    const token = evidence(repo);
    let invalid: unknown = {};
    if (kind === "copy") invalid = { ...token };
    if (kind === "proxy") invalid = new Proxy(token, {});
    if (kind === "latest") {
      db.prepare(
        "UPDATE published_state_snapshots SET snapshot_json=? WHERE generation=2",
      ).run(json(2));
      invalid = repo.read("schedule", validator);
    }
    if (kind === "empty") invalid = repo.read("currentWeather", validator);
    const before = image(db);
    expect(
      repo.saveConditionally(request(invalid as ReadEvidence)),
    ).toMatchObject({ outcome: "not_saved", reason: "invalid_read_evidence" });
    expect(image(db)).toEqual(before);
  },
);
test("I-08 valid identity is frozen and restricted to its original State", () => {
  const { db, repo } = fixture();
  seed(db);
  const token = evidence(repo);
  expect(() =>
    Object.defineProperty(token, "source", { value: "latest" }),
  ).toThrow();
  expect(
    repo.saveConditionally({ ...request(token), stateKey: "currentWeather" }),
  ).toMatchObject({ outcome: "not_saved", reason: "invalid_read_evidence" });
});
test("I-09 token belongs to its Connection, not just identical DB bytes", () => {
  const a = fixture();
  seed(a.db);
  const token = evidence(a.repo);
  const b = fixture();
  seed(b.db);
  expect(b.repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "invalid_read_evidence",
  });
});
test("I-09 token cannot be used after Connection close, including after reopen", () => {
  const { db, repo } = fixture();
  seed(db);
  const token = evidence(repo);
  const name = db.name;
  db.close();
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "invalid_read_evidence",
  });
  expect(
    new PublishedStateRepository(secondary(name)).saveConditionally(
      request(token),
    ),
  ).toMatchObject({ outcome: "not_saved", reason: "invalid_read_evidence" });
});
test.each([
  "Counter value",
  "Counter missing",
  "Snapshot count",
  "Generation",
  "JSON",
  "JSON whitespace",
  "deleted previous",
])("I-10 changed %s fails Tx-P evidence check before writes", (fault) => {
  const { db, repo } = fixture();
  seed(db);
  const token = evidence(repo);
  if (fault === "Counter value")
    db.exec("UPDATE state_generation_counters SET last_generation=3");
  if (fault === "Counter missing")
    db.exec("DELETE FROM state_generation_counters");
  if (fault === "Snapshot count")
    db.exec(
      "INSERT INTO published_state_snapshots VALUES ('schedule',3,'{}');UPDATE state_generation_counters SET last_generation=3",
    );
  if (fault === "Generation")
    db.exec(
      "UPDATE published_state_snapshots SET generation=3 WHERE generation=2;UPDATE state_generation_counters SET last_generation=3",
    );
  if (fault === "JSON")
    db.exec(
      "UPDATE published_state_snapshots SET snapshot_json='changed' WHERE generation=1",
    );
  if (fault === "JSON whitespace")
    db.prepare(
      "UPDATE published_state_snapshots SET snapshot_json=? WHERE generation=1",
    ).run(" " + json(1));
  if (fault === "deleted previous")
    db.exec("DELETE FROM published_state_snapshots WHERE generation=1");
  const before = image(db);
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "stale_read_evidence",
  });
  expect(image(db)).toEqual(before);
  expect(db.inTransaction).toBe(false);
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_read_evidence",
  });
});
test.each(["unknown", "not_newer"] as const)(
  "I-11 %s adoption does not infer freshness from Generation or timestamps",
  (outcome) => {
    const { db, repo } = fixture();
    seed(db);
    const token = evidence(repo);
    const before = image(db);
    const exec = vi.spyOn(db, "exec");
    expect(
      repo.saveConditionally({
        ...request(token),
        adoption: { outcome },
        snapshotJson: json(999),
      }),
    ).toMatchObject({ outcome: "not_saved", reason: "adoption_not_newer" });
    expect(exec).not.toHaveBeenCalled();
    expect(image(db)).toEqual(before);
  },
);
test("I-12/I-15 prior token + newer saves and may delete the only previously valid generation", () => {
  const { db, repo } = fixture();
  seed(db);
  const token = evidence(repo);
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "saved",
    generation: 3,
  });
  expect(
    db
      .prepare(
        "SELECT generation,snapshot_json FROM published_state_snapshots ORDER BY generation DESC",
      )
      .all(),
  ).toEqual([
    { generation: 3, snapshot_json: json(3) },
    { generation: 2, snapshot_json: "{" },
  ]);
  expect(repo.read("schedule", validator)).toMatchObject({
    outcome: "latest",
    generation: 3,
  });
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_read_evidence",
  });
});
test("I-12 token works through another Repository on the same Connection and has no time expiry", () => {
  const { db, repo, logger } = fixture();
  seed(db);
  const token = evidence(repo);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2035-01-01"));
  expect(
    new PublishedStateRepository(db, logger).saveConditionally(request(token)),
  ).toMatchObject({ outcome: "saved", generation: 3 });
});
test("I-13 Commit success then notification exception uses full existing reconciliation", () => {
  const { db, repo } = fixture();
  seed(db);
  const token = evidence(repo);
  commitFault(db, true);
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "saved",
    generation: 3,
    reconciled: true,
  });
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_read_evidence",
  });
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM published_state_snapshots").get(),
  ).toEqual({ count: 2 });
});
test("I-13 Rollback confirms no save but cannot revive consumed evidence", () => {
  const { db, repo } = fixture();
  seed(db);
  const token = evidence(repo);
  const before = image(db);
  commitFault(db, false);
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    scope: "database",
    layer: "L1",
  });
  expect(image(db)).toEqual(before);
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_read_evidence",
  });
  expect(repo.saveConditionally(request(evidence(repo)))).toMatchObject({
    outcome: "saved",
  });
});
test("I-13 unresolved Commit blocks same-State read/save but explicit reconcile remains compatible", () => {
  const { db, repo } = fixture();
  seed(db);
  const token = evidence(repo);
  let rejectRead = false;
  commitFault(db, true, () => {
    rejectRead = true;
  });
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (rejectRead && sql.startsWith("SELECT last_generation"))
      throw sqlFailure();
    return prepare(sql);
  });
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "unknown",
  });
  expect(repo.save("schedule", json(4))).toMatchObject({
    outcome: "unknown",
    reason: "unresolved_save",
  });
  expect(repo.read("schedule", validator)).toMatchObject({
    outcome: "isolated",
    reason: "unresolved_save",
  });
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_read_evidence",
  });
  rejectRead = false;
  expect(repo.read("currentWeather", validator)).toEqual({
    outcome: "empty",
    kind: "new",
  });
  expect(repo.reconcile("schedule")).toMatchObject({
    outcome: "saved",
    generation: 3,
    reconciled: true,
  });
  expect(repo.read("schedule", validator).outcome).toBe("latest");
});
test("I-14 Counter isolation leaves normal States available and never repairs rows", () => {
  const { db, repo } = fixture();
  seed(db, "{", json(1), null);
  const before = image(db);
  expect(repo.read("schedule", validator).outcome).toBe("isolated");
  expect(image(db)).toEqual(before);
  expect(repo.save("currentWeather", json(4))).toMatchObject({
    outcome: "saved",
  });
  expect(repo.read("currentWeather", validator).outcome).toBe("latest");
});
test("I-16 normal save and reconcile signatures remain compatible, including known direct-save bypass", () => {
  const { db, repo } = fixture();
  seed(db);
  expect(repo.read("schedule", validator).outcome).toBe("previous");
  expect(repo.save("schedule", json(3))).toMatchObject({
    outcome: "saved",
    generation: 3,
  });
  expect(repo.reconcile("schedule")).toMatchObject({
    outcome: "not_saved",
    reason: "no_pending_attempt",
  });
});
test("empty differentiates truly new State from counter-only history", () => {
  const { db, repo } = fixture();
  expect(repo.read("schedule", validator)).toEqual({
    outcome: "empty",
    kind: "new",
  });
  db.prepare(
    "INSERT INTO state_generation_counters VALUES ('schedule',40)",
  ).run();
  expect(repo.read("schedule", validator)).toEqual({
    outcome: "empty",
    kind: "counter_only",
  });
  expect(repo.save("schedule", json(41))).toMatchObject({
    outcome: "saved",
    generation: 41,
  });
});
test("safe Generation maximum can be read but conditional increment is refused", () => {
  const { db, repo } = fixture();
  seed(db, "{", json(1), Number.MAX_SAFE_INTEGER);
  db.prepare(
    "UPDATE published_state_snapshots SET generation=? WHERE generation=2",
  ).run(Number.MAX_SAFE_INTEGER);
  const token = evidence(repo);
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "generation_exhausted",
  });
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_read_evidence",
  });
});
test("Schema incompatibility is a whole-DB L3 error without Validator/evidence", () => {
  const { db, repo } = fixture();
  seed(db);
  db.exec("DROP TABLE state_generation_counters");
  const schema = vi.fn(validator.schema);
  expect(repo.read("schedule", { ...validator, schema })).toMatchObject({
    outcome: "database_error",
    layer: "L3",
  });
  expect(schema).not.toHaveBeenCalled();
  expect(repo.read("currentWeather", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L3",
  });
});
test("temporary SQL error aborts Read without evidence and can be re-read explicitly", () => {
  const { db, repo } = fixture();
  seed(db);
  const prepare = db.prepare.bind(db);
  let fail = true;
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (fail && sql.startsWith("SELECT last_generation")) throw sqlFailure();
    return prepare(sql);
  });
  expect(repo.read("schedule", validator)).toEqual({
    outcome: "database_error",
    layer: "L1",
    reason: "temporary_sql",
  });
  expect(db.inTransaction).toBe(false);
  fail = false;
  expect(repo.read("schedule", validator).outcome).toBe("previous");
});
test.each([false, true])(
  "Read COMMIT exception after=%s issues no evidence",
  (after) => {
    const { db, repo } = fixture();
    seed(db);
    commitFault(db, after);
    expect(repo.read("schedule", validator)).toMatchObject({
      outcome: "database_error",
      layer: "L1",
    });
    expect(db.inTransaction).toBe(false);
    expect(repo.read("schedule", validator).outcome).toBe("previous");
  },
);
test("Read Rollback failure halts all operations on the unresolved Connection", () => {
  const { db, repo } = fixture();
  seed(db);
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" || sql === "ROLLBACK") throw sqlFailure();
    return exec(sql);
  });
  expect(repo.read("schedule", validator)).toEqual({
    outcome: "database_error",
    layer: "L4",
    reason: "transaction_unresolved",
  });
  expect(repo.read("currentWeather", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L4",
  });
  expect(repo.save("currentWeather", json(1))).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
});
test("conditional Rollback failure preserves B-3B-1 shared Connection stop", () => {
  const { db, repo } = fixture();
  seed(db);
  const token = evidence(repo);
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" || sql === "ROLLBACK") throw sqlFailure();
    return exec(sql);
  });
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
  expect(repo.read("currentWeather", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L4",
  });
});
test("pre-existing Transaction is not joined or rolled back by Read", () => {
  const { db, repo } = fixture();
  seed(db);
  db.exec("BEGIN");
  expect(repo.read("schedule", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L4",
  });
  expect(db.inTransaction).toBe(true);
});
test("unsupported key does no SQL or validation", () => {
  const { db, repo } = fixture();
  const exec = vi.spyOn(db, "exec");
  const schema = vi.fn(validator.schema);
  expect(repo.read("photo", { ...validator, schema })).toMatchObject({
    outcome: "isolated",
    reason: "unsupported_state",
  });
  expect(exec).not.toHaveBeenCalled();
  expect(schema).not.toHaveBeenCalled();
});
test("candidate syntax failure consumes evidence without modifying DB", () => {
  const { db, repo } = fixture();
  seed(db);
  const token = evidence(repo);
  const before = image(db);
  expect(
    repo.saveConditionally({ ...request(token), snapshotJson: "{" }),
  ).toMatchObject({ outcome: "not_saved", reason: "invalid_candidate_json" });
  expect(image(db)).toEqual(before);
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_read_evidence",
  });
});
test("Logging errors cannot change the Read classification", () => {
  const { db, repo, logger } = fixture();
  seed(db);
  logger.warn.mockImplementation(() => {
    throw new Error("logging failed");
  });
  expect(repo.read("schedule", validator).outcome).toBe("previous");
});

test.each([
  ["{", []],
  ["{}", ["schema"]],
  [json(-1), ["schema", "semantic"]],
] as const)(
  "I-01 failure short-circuits remaining validation for %s",
  (latest, expected) => {
    const { db, repo } = fixture();
    seed(db, latest, null);
    const order: string[] = [];
    const wrapped: SnapshotValidator<Sample> = {
      schema(v) {
        order.push("schema");
        return validator.schema(v);
      },
      semantic(v) {
        order.push("semantic");
        return validator.semantic(v);
      },
    };
    expect(repo.read("schedule", wrapped).outcome).toBe("isolated");
    expect(order).toEqual(expected);
  },
);
test("I-10/I-12 evidence recheck runs under BEGIN IMMEDIATE and excludes a competing writer", () => {
  const { db, repo } = fixture();
  seed(db);
  const token = evidence(repo);
  const writer = secondary(db.name);
  writer.pragma("busy_timeout=0");
  const exec = db.exec.bind(db);
  const prepare = db.prepare.bind(db);
  let checking = false;
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE") {
      checking = true;
      expect(() =>
        writer.exec("UPDATE state_generation_counters SET last_generation=99"),
      ).toThrow();
    }
    return result;
  });
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (
      sql.startsWith("SELECT last_generation") ||
      sql.startsWith("SELECT generation,")
    ) {
      expect(checking).toBe(true);
      expect(db.inTransaction).toBe(true);
    }
    return prepare(sql);
  });
  expect(repo.saveConditionally(request(token))).toMatchObject({
    outcome: "saved",
    generation: 3,
  });
});
test("unsafe Snapshot Generation cannot produce a read candidate or evidence", () => {
  const { db, repo } = fixture();
  seed(db);
  db.prepare(
    "UPDATE published_state_snapshots SET generation=? WHERE generation=2",
  ).run(9007199254740992n);
  expect(repo.read("schedule", validator)).toEqual({
    outcome: "isolated",
    reason: "integer_out_of_range",
  });
});
test("L2 read failure is not a normal empty State", () => {
  const { db, repo } = fixture();
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("SELECT last_generation"))
      throw Object.assign(new Error(), { code: "SQLITE_CANTOPEN" });
    return prepare(sql);
  });
  expect(repo.read("schedule", validator)).toEqual({
    outcome: "database_error",
    layer: "L2",
    reason: "database_unavailable",
  });
});
test("unreadable Connection Transaction status cannot issue evidence or run Validators", () => {
  const { db, logger } = fixture();
  seed(db);
  const uncertain = new Proxy(db, {
    get(target, property) {
      if (property === "inTransaction") throw new Error("unknown");
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const repo = new PublishedStateRepository(uncertain, logger);
  const schema = vi.fn(validator.schema);
  expect(repo.read("schedule", { ...validator, schema })).toEqual({
    outcome: "database_error",
    layer: "L4",
    reason: "transaction_unresolved",
  });
  expect(schema).not.toHaveBeenCalled();
  expect(repo.read("currentWeather", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L4",
  });
});
test("Validator-controlled failure reasons are not copied into logs", () => {
  const { db, repo, logger } = fixture();
  seed(db, json(2));
  const wrapped: SnapshotValidator<Sample> = {
    ...validator,
    schema(value) {
      const result = validator.schema(value);
      return result.valid && result.value.data.value === 2
        ? { valid: false, reason: "sensitive reason" }
        : result;
    },
  };
  expect(repo.read("schedule", wrapped)).toMatchObject({
    outcome: "previous",
    latestInvalid: { reason: "sensitive reason" },
  });
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("sensitive");
});
