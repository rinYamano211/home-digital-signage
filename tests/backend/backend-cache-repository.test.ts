import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import {
  BackendCacheRepository,
  type CacheEntry,
  type CacheReadEvidence,
  type CacheReadResult,
  type CacheConditionalSaveRequest,
} from "../../src/backend/storage/backend-cache-repository.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import { evaluateCacheRead } from "../../src/backend/storage/cache-entry.js";
import {
  PublishedStateRepository,
  type SnapshotValidator,
  type StateKey,
} from "../../src/backend/storage/published-state-repository.js";
import { configureDatabase } from "../../src/backend/storage/store.js";
import { initializeSchema } from "../../src/backend/storage/schema.js";

interface Data {
  value: number;
}
const entry = (value = 1): CacheEntry<Data> => ({
  schemaVersion: 1,
  data: { value },
  dataUpdatedAt: "2026-10-25T00:00:00Z",
  expiresAt: "2026-10-25T02:00:00Z",
});
const validator: SnapshotValidator<Data> = {
  schema(value) {
    return value !== null &&
      typeof value === "object" &&
      "value" in value &&
      typeof value.value === "number"
      ? { valid: true, value: value as Data }
      : { valid: false, reason: "domain_schema" };
  },
  semantic(value) {
    return value.value >= 0
      ? { valid: true, value }
      : { valid: false, reason: "domain_semantic" };
  },
};
const opened: Database.Database[] = [];
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "signage-cache-"));
  dirs.push(dir);
  const db = new Database(join(dir, "cache.db"));
  opened.push(db);
  configureDatabase(db);
  initializeSchema(db);
  const logger = { warn: vi.fn(), error: vi.fn() };
  return {
    db,
    cache: new BackendCacheRepository(db, logger),
    published: new PublishedStateRepository(db, logger),
    logger,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function seed(
  db: Database.Database,
  json = JSON.stringify(entry()),
  state: StateKey = "schedule",
) {
  db.prepare("INSERT INTO backend_cache VALUES (?,?)").run(state, json);
}
function token<T>(result: CacheReadResult<T>): CacheReadEvidence {
  if (!("evidence" in result)) throw new Error("Expected Cache evidence");
  return result.evidence;
}
function request(
  evidence: CacheReadEvidence,
  value = 1,
  stateKey: StateKey = "schedule",
): CacheConditionalSaveRequest<Data> {
  return {
    stateKey,
    entry: entry(value),
    evidence,
    adoption: { outcome: "adopt" },
  };
}
function row(db: Database.Database, state = "schedule") {
  return db
    .prepare("SELECT cache_json FROM backend_cache WHERE state_key=?")
    .get(state);
}
function stateImage(db: Database.Database) {
  return {
    rows: db
      .prepare(
        "SELECT * FROM published_state_snapshots ORDER BY state_key,generation",
      )
      .all(),
    counters: db
      .prepare("SELECT * FROM state_generation_counters ORDER BY state_key")
      .all(),
  };
}
const busy = () =>
  Object.assign(new Error("secret fault details"), { code: "SQLITE_BUSY" });
function faultCommit(db: Database.Database, after: boolean, hook?: () => void) {
  const exec = db.exec.bind(db);
  let once = true;
  return vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" && once) {
      once = false;
      if (after) exec(sql);
      hook?.();
      throw busy();
    }
    return exec(sql);
  });
}

test("C-01 empty Read issues opaque evidence without Domain validation or writes", () => {
  const { db, cache } = fixture();
  const schema = vi.fn(validator.schema);
  const result = cache.read("schedule", { ...validator, schema });
  expect(result.outcome).toBe("empty");
  expect(Object.isFrozen(token(result))).toBe(true);
  expect(Reflect.ownKeys(token(result))).toEqual([]);
  expect(schema).not.toHaveBeenCalled();
  expect(row(db)).toBeUndefined();
});
test("C-02 Read validates common envelope before Domain Schema/Semantics and ends Transaction first", () => {
  const { db, cache } = fixture();
  seed(db);
  const order: string[] = [];
  const before = row(db);
  const wrapped: SnapshotValidator<Data> = {
    schema(value) {
      expect(db.inTransaction).toBe(false);
      order.push("schema");
      expect(value).toEqual({ value: 1 });
      return validator.schema(value);
    },
    semantic(value) {
      expect(db.inTransaction).toBe(false);
      order.push("semantic");
      return validator.semantic(value);
    },
  };
  const result = cache.read("schedule", wrapped);
  expect(result).toMatchObject({ outcome: "found", entry: entry() });
  expect(order).toEqual(["schema", "semantic"]);
  expect(row(db)).toEqual(before);
});
test.each(["{", "undefined", ""])(
  "C-03 malformed JSON %s is invalid with evidence",
  (json) => {
    const { db, cache } = fixture();
    seed(db, json);
    const schema = vi.fn(validator.schema);
    const result = cache.read("schedule", { ...validator, schema });
    expect(result).toMatchObject({ outcome: "invalid", stage: "json_parse" });
    expect(token(result)).toBeTruthy();
    expect(schema).not.toHaveBeenCalled();
  },
);
test.each([
  {
    schemaVersion: 2,
    data: { value: 1 },
    dataUpdatedAt: entry().dataUpdatedAt,
    expiresAt: entry().expiresAt,
  },
  { schemaVersion: 1, data: { value: 1 }, expiresAt: entry().expiresAt },
  { ...entry(), dataUpdatedAt: "2026-02-30T00:00:00Z" },
  { ...entry(), expiresAt: "2026-10-25T02:00:00+09:00" },
  { ...entry(), data: {} },
])(
  "C-04 common/Domain Schema failure is invalid(schema), not database_error",
  (candidate) => {
    const { db, cache } = fixture();
    seed(db, JSON.stringify(candidate));
    const result = cache.read("schedule", validator);
    expect(result).toMatchObject({ outcome: "invalid", stage: "schema" });
    expect(token(result)).toBeTruthy();
  },
);
test("C-05 Semantic rejection has an invalid token, not Fallback data", () => {
  const { db, cache } = fixture();
  seed(db, JSON.stringify(entry(-1)));
  const result = cache.read("schedule", validator);
  expect(result).toMatchObject({
    outcome: "invalid",
    stage: "semantic",
    reason: "domain_semantic",
  });
  expect(evaluateCacheRead(result, Date.parse(entry().dataUpdatedAt))).toEqual({
    outcome: "invalid",
  });
});
test.each(["schema", "semantic"] as const)(
  "C-06 %s exception issues no evidence and does not mark Cache invalid",
  (stage) => {
    const { db, cache, logger } = fixture();
    seed(db);
    const wrapped = { ...validator };
    wrapped[stage] = () => {
      throw new Error("secret credentials");
    };
    const result = cache.read("schedule", wrapped);
    expect(result).toMatchObject({ outcome: "validator_error", stage });
    expect(result).not.toHaveProperty("evidence");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret");
    expect(cache.read("schedule", validator).outcome).toBe("found");
  },
);
test.each(["SQLITE_BUSY", "SQLITE_CANTOPEN"])(
  "C-07 %s Read failure issues no evidence",
  (code) => {
    const { db, cache } = fixture();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("SELECT cache_json"))
        throw Object.assign(new Error(), { code });
      return prepare(sql);
    });
    const result = cache.read("schedule", validator);
    expect(result).toMatchObject({
      outcome: "database_error",
      layer: code === "SQLITE_BUSY" ? "L1" : "L2",
    });
    expect(result).not.toHaveProperty("evidence");
    expect(db.inTransaction).toBe(false);
  },
);
test("C-08/C-17 first save creates only the existing Cache Row", () => {
  const { db, cache } = fixture();
  const evidence = token(cache.read("schedule", validator));
  const schema = db.prepare("SELECT * FROM sqlite_schema").all();
  expect(cache.saveConditionally(request(evidence))).toEqual({
    outcome: "saved",
    reconciled: false,
  });
  expect(row(db)).toEqual({ cache_json: JSON.stringify(entry()) });
  expect(db.prepare("SELECT * FROM sqlite_schema").all()).toEqual(schema);
  expect(db.pragma("user_version", { simple: true })).toBe(2);
});
test.each([
  { ...entry(), schemaVersion: 2 },
  {
    schemaVersion: 1,
    data: { value: 1 },
    dataUpdatedAt: entry().dataUpdatedAt,
  },
  { ...entry(), dataUpdatedAt: "not a time" },
  { ...entry(), expiresAt: "2026-02-29T00:00:00Z" },
  { ...entry(), data: undefined },
  { ...entry(), data: 1n },
  { ...entry(), data: { value: Infinity } },
  { ...entry(), data: { value: undefined } },
])(
  "C-08/C-16 bad candidate is refused before Transaction without consuming evidence",
  (candidate) => {
    const { db, cache } = fixture();
    const evidence = token(cache.read("schedule", validator));
    const exec = vi.spyOn(db, "exec");
    expect(
      cache.saveConditionally({
        ...request(evidence),
        entry: candidate as CacheEntry<Data>,
      }),
    ).toMatchObject({
      outcome: "not_saved",
      scope: "input",
      reason: "invalid_cache_entry",
    });
    expect(exec).not.toHaveBeenCalled();
    expect(cache.saveConditionally(request(evidence))).toMatchObject({
      outcome: "saved",
    });
  },
);
test("C-08 cyclic and toJSON-altered envelopes are rejected; valid input can reuse token", () => {
  const { db, cache } = fixture();
  const evidence = token(cache.read("schedule", validator));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(
    cache.saveConditionally({
      ...request(evidence),
      entry: { ...entry(), data: cycle } as unknown as CacheEntry<Data>,
    }),
  ).toMatchObject({ outcome: "not_saved", scope: "input" });
  const altered = {
    ...entry(),
    toJSON() {
      return { ...entry(), schemaVersion: 2 };
    },
  };
  expect(
    cache.saveConditionally({ ...request(evidence), entry: altered }),
  ).toMatchObject({ outcome: "not_saved", scope: "input" });
  expect(row(db)).toBeUndefined();
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "saved",
  });
});
test("C-09 concurrent insert after empty Read is detected and never overwritten", () => {
  const { db, cache } = fixture();
  const evidence = token(cache.read("schedule", validator));
  seed(db, JSON.stringify(entry(9)));
  const before = row(db);
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "not_saved",
    reason: "stale_cache_evidence",
  });
  expect(row(db)).toEqual(before);
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_cache_evidence",
  });
});
test("C-10 bad Cache is replaced only through explicit Application adoption", () => {
  const { db, cache } = fixture();
  seed(db, "{");
  const evidence = token(cache.read("schedule", validator));
  expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
    outcome: "saved",
  });
  expect(cache.read("schedule", validator)).toMatchObject({
    outcome: "found",
    entry: entry(2),
  });
});
test.each(["reject", "unknown"] as const)(
  "C-11/C-13/C-14/C-16 adoption=%s refuses invalid or stale data without token consumption",
  (outcome) => {
    const { db, cache } = fixture();
    seed(db, "{");
    const evidence = token(cache.read("schedule", validator));
    const exec = vi.spyOn(db, "exec");
    expect(
      cache.saveConditionally({ ...request(evidence), adoption: { outcome } }),
    ).toMatchObject({ outcome: "not_saved", reason: "adoption_not_confirmed" });
    expect(exec).not.toHaveBeenCalled();
    expect(row(db)).toEqual({ cache_json: "{" });
    expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
      outcome: "saved",
    });
  },
);
test("C-12 normal update honors adoption instead of universal timestamp ordering", () => {
  const { db, cache } = fixture();
  seed(db);
  const evidence = token(cache.read("schedule", validator));
  const olderTimestamp = { ...entry(2), dataUpdatedAt: "2020-01-01T00:00:00Z" };
  expect(
    cache.saveConditionally({ ...request(evidence), entry: olderTimestamp }),
  ).toMatchObject({ outcome: "saved" });
  expect(row(db)).toEqual({ cache_json: JSON.stringify(olderTimestamp) });
});
test.each(["content", "whitespace", "removed"])(
  "C-15 Row %s change is rejected by Tx-C CAS",
  (fault) => {
    const { db, cache } = fixture();
    seed(db);
    const evidence = token(cache.read("schedule", validator));
    if (fault === "removed") db.exec("DELETE FROM backend_cache");
    else
      db.prepare("UPDATE backend_cache SET cache_json=?").run(
        fault === "content"
          ? JSON.stringify(entry(8))
          : " " + JSON.stringify(entry()),
      );
    const before = row(db);
    expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
      outcome: "not_saved",
      reason: "stale_cache_evidence",
    });
    expect(row(db)).toEqual(before);
  },
);
test("C-16 fake/copied/proxied/Published evidence cannot authorize Cache writes", () => {
  const { cache, published } = fixture();
  const valid = token(cache.read("schedule", validator));
  published.save("schedule", JSON.stringify({ value: 1 }));
  published.save("schedule", "{}");
  const snapshotValidator: SnapshotValidator<Data> = {
    schema: validator.schema,
    semantic: validator.semantic,
  };
  const p = published.read("schedule", snapshotValidator);
  expect(p.outcome).toBe("previous");
  if (p.outcome !== "previous") throw new Error();
  for (const evidence of [{}, { ...valid }, new Proxy(valid, {}), p.evidence])
    expect(
      cache.saveConditionally(request(evidence as CacheReadEvidence)),
    ).toMatchObject({ outcome: "not_saved", reason: "invalid_cache_evidence" });
  expect(cache.saveConditionally(request(valid))).toMatchObject({
    outcome: "saved",
  });
});
test("C-16 token is State/Connection-bound, frozen and shareable only on the same Connection", () => {
  const { db, cache, logger } = fixture();
  const evidence = token(cache.read("schedule", validator));
  const other = fixture();
  expect(() =>
    Object.defineProperty(evidence, "row", { value: "forged" }),
  ).toThrow();
  expect(other.cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "not_saved",
    reason: "invalid_cache_evidence",
  });
  expect(
    cache.saveConditionally(request(evidence, 1, "currentWeather")),
  ).toMatchObject({ outcome: "not_saved", reason: "invalid_cache_evidence" });
  expect(
    new BackendCacheRepository(db, logger).saveConditionally(request(evidence)),
  ).toMatchObject({ outcome: "saved" });
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_cache_evidence",
  });
});
test("C-16 closed/reopened Connection cannot reuse token", () => {
  const { db, cache } = fixture();
  const evidence = token(cache.read("schedule", validator));
  const name = db.name;
  db.close();
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "not_saved",
    reason: "invalid_cache_evidence",
  });
  const reopened = new Database(name);
  opened.push(reopened);
  expect(
    new BackendCacheRepository(reopened).saveConditionally(request(evidence)),
  ).toMatchObject({ outcome: "not_saved", reason: "invalid_cache_evidence" });
});
test("C-16 BEGIN failure consumes evidence even though no Row was written", () => {
  const { db, cache } = fixture();
  const evidence = token(cache.read("schedule", validator));
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "BEGIN IMMEDIATE") throw busy();
    return exec(sql);
  });
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "not_saved",
    layer: "L1",
  });
  expect(row(db)).toBeUndefined();
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_cache_evidence",
  });
});
test("C-18 unchanged does no INSERT/UPDATE and consumes evidence", () => {
  const { db, cache } = fixture();
  seed(db);
  const evidence = token(cache.read("schedule", validator));
  const prepare = vi.spyOn(db, "prepare");
  expect(cache.saveConditionally(request(evidence))).toEqual({
    outcome: "unchanged",
  });
  expect(
    prepare.mock.calls.filter(([sql]) => /^(INSERT|UPDATE)/.test(sql)),
  ).toHaveLength(0);
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_cache_evidence",
  });
});
test("C-19 failed UPSERT rolls back and preserves old Cache", () => {
  const { db, cache } = fixture();
  seed(db);
  const evidence = token(cache.read("schedule", validator));
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("INSERT INTO backend_cache")) throw busy();
    return prepare(sql);
  });
  expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
    outcome: "not_saved",
    layer: "L1",
  });
  expect(row(db)).toEqual({ cache_json: JSON.stringify(entry()) });
  expect(db.inTransaction).toBe(false);
});
test("C-20 successful Commit exception reconciles the JSON serialized exactly once", () => {
  const { db, cache } = fixture();
  const evidence = token(cache.read("schedule", validator));
  let serializations = 0;
  const candidate = {
    ...entry(),
    data: {
      value: 0,
      toJSON() {
        return { value: ++serializations };
      },
    },
  };
  faultCommit(db, true);
  expect(
    cache.saveConditionally({ ...request(evidence), entry: candidate }),
  ).toEqual({ outcome: "saved", reconciled: true });
  expect(serializations).toBe(1);
  expect(row(db)).toEqual({ cache_json: JSON.stringify(entry()) });
});
test.each([false, true])(
  "C-21 failed Commit restores previous Row (existing=%s)",
  (exists) => {
    const { db, cache } = fixture();
    if (exists) seed(db);
    const evidence = token(cache.read("schedule", validator));
    const before = row(db);
    faultCommit(db, false);
    expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
      outcome: "not_saved",
      layer: "L1",
    });
    expect(row(db)).toEqual(before);
    expect(db.inTransaction).toBe(false);
    expect(cache.read("schedule", validator).outcome).toBe(
      exists ? "found" : "empty",
    );
  },
);
test("C-22 different Row after Commit is unknown; normal read returns pending without data/evidence", () => {
  const { db, cache } = fixture();
  seed(db);
  const evidence = token(cache.read("schedule", validator));
  faultCommit(db, true, () => {
    db.prepare("UPDATE backend_cache SET cache_json=?").run(
      JSON.stringify(entry(8)),
    );
  });
  expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
    outcome: "unknown",
    scope: "state",
  });
  const result = cache.read("schedule", validator);
  expect(result).toEqual({
    outcome: "pending",
    reason: "commit_result_unknown",
  });
  expect(result).not.toHaveProperty("entry");
  expect(result).not.toHaveProperty("evidence");
  expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
    outcome: "unknown",
    reason: "commit_result_unknown",
  });
  expect(evaluateCacheRead(result, Date.now()).outcome).toBe("unavailable");
});
test.each([true, false])(
  "C-22/C-23 unreadable comparison is pending until read-only reconcile (committed=%s)",
  (committed) => {
    const { db, cache, logger } = fixture();
    seed(db);
    const evidence = token(cache.read("schedule", validator));
    let rejectRead = false;
    faultCommit(db, committed, () => {
      rejectRead = true;
    });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (rejectRead && sql.startsWith("SELECT cache_json")) throw busy();
      return prepare(sql);
    });
    expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
      outcome: "unknown",
    });
    expect(
      new BackendCacheRepository(db, logger).read("schedule", validator)
        .outcome,
    ).toBe("pending");
    expect(cache.reconcile("schedule")).toMatchObject({ outcome: "unknown" });
    expect(cache.read("schedule", validator).outcome).toBe("pending");
    rejectRead = false;
    const spy = vi.spyOn(db, "prepare");
    spy.mockClear();
    expect(cache.reconcile("schedule")).toMatchObject({
      outcome: committed ? "saved" : "not_saved",
    });
    expect(
      spy.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql)),
    ).toHaveLength(0);
    expect(cache.read("schedule", validator)).toMatchObject({
      outcome: "found",
      entry: entry(committed ? 2 : 1),
    });
  },
);
test("C-18/C-22 identical before/planned JSON cannot be proven saved after Commit exception", () => {
  const { db, cache } = fixture();
  seed(db);
  const evidence = token(cache.read("schedule", validator));
  faultCommit(db, true);
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "unknown",
    reason: "indistinguishable_cache_images",
  });
  expect(cache.read("schedule", validator).outcome).toBe("pending");
  expect(cache.reconcile("schedule")).toMatchObject({
    outcome: "unknown",
    reason: "indistinguishable_cache_images",
  });
});
test("C-24 Tx-P excludes Tx-C entry on the same Connection", () => {
  const { db, cache, published } = fixture();
  const evidence = token(cache.read("schedule", validator));
  const exec = db.exec.bind(db);
  let nested: unknown;
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE") {
      expect(db.inTransaction).toBe(true);
      nested = cache.saveConditionally(request(evidence));
    }
    return result;
  });
  expect(
    published.save("schedule", JSON.stringify({ value: 1 })),
  ).toMatchObject({ outcome: "saved" });
  expect(nested).toMatchObject({
    outcome: "not_saved",
    reason: "connection_busy",
  });
  expect(row(db)).toBeUndefined();
});
test("C-25 Tx-C excludes Tx-P, even through another Repository instance", () => {
  const { db, cache, logger } = fixture();
  const evidence = token(cache.read("schedule", validator));
  const published = new PublishedStateRepository(db, logger);
  const exec = db.exec.bind(db);
  let nested: unknown;
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE") {
      expect(db.inTransaction).toBe(true);
      nested = published.save("schedule", JSON.stringify({ value: 1 }));
    }
    return result;
  });
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "saved",
  });
  expect(nested).toMatchObject({
    outcome: "not_saved",
    reason: "connection_busy",
  });
  expect(stateImage(db)).toEqual({ rows: [], counters: [] });
});
test("C-26 Cache Validator cannot reenter Cache/Published Repositories and runs outside Transaction", () => {
  const { db, cache, published } = fixture();
  seed(db);
  const wrapped: SnapshotValidator<Data> = {
    ...validator,
    schema(value) {
      expect(db.inTransaction).toBe(false);
      expect(cache.read("currentWeather", validator)).toMatchObject({
        outcome: "database_error",
        reason: "connection_busy",
      });
      expect(published.read("schedule", validator)).toMatchObject({
        outcome: "database_error",
        reason: "connection_busy",
      });
      expect(published.save("schedule", "{}")).toMatchObject({
        outcome: "not_saved",
        reason: "connection_busy",
      });
      return validator.schema(value);
    },
  };
  expect(cache.read("schedule", wrapped).outcome).toBe("found");
});
test("C-26 Published Validator also excludes Cache DB operations", () => {
  const { cache, published } = fixture();
  published.save("schedule", JSON.stringify({ value: 1 }));
  const wrapped: SnapshotValidator<Data> = {
    ...validator,
    schema(value) {
      expect(cache.read("currentWeather", validator)).toMatchObject({
        outcome: "database_error",
        reason: "connection_busy",
      });
      return validator.schema(value);
    },
  };
  expect(published.read("schedule", wrapped).outcome).toBe("latest");
});
test("C-27 Cache pending is local; other Cache State and Tx-P continue", () => {
  const { db, cache, published } = fixture();
  const evidence = token(cache.read("schedule", validator));
  let rejectRead = false;
  faultCommit(db, true, () => {
    rejectRead = true;
  });
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (rejectRead && sql.startsWith("SELECT cache_json")) throw busy();
    return prepare(sql);
  });
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "unknown",
  });
  rejectRead = false;
  expect(cache.read("schedule", validator).outcome).toBe("pending");
  expect(cache.read("currentWeather", validator).outcome).toBe("empty");
  expect(
    published.save("schedule", JSON.stringify({ value: 1 })),
  ).toMatchObject({ outcome: "saved" });
  const other = token(cache.read("currentWeather", validator));
  expect(
    cache.saveConditionally(request(other, 2, "currentWeather")),
  ).toMatchObject({ outcome: "saved" });
  expect(cache.read("schedule", validator).outcome).toBe("pending");
});
test.each(["cache", "published"])(
  "C-28 %s Rollback failure stops every Repository",
  (owner) => {
    const { db, cache, published, logger } = fixture();
    const evidence = token(cache.read("schedule", validator));
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT" || sql === "ROLLBACK") throw busy();
      return exec(sql);
    });
    const result =
      owner === "cache"
        ? cache.saveConditionally(request(evidence))
        : published.save("schedule", JSON.stringify({ value: 1 }));
    expect(result).toMatchObject({
      outcome: "unknown",
      reason: "transaction_unresolved",
    });
    expect(
      new BackendCacheRepository(db, logger).read("currentWeather", validator),
    ).toMatchObject({
      outcome: "database_error",
      layer: "L4",
      reason: "transaction_unresolved",
    });
    expect(
      new PublishedStateRepository(db, logger).save("currentWeather", "{}"),
    ).toMatchObject({ outcome: "unknown", reason: "transaction_unresolved" });
    expect(cache.reconcile("schedule")).toMatchObject({
      outcome: "unknown",
      reason: "transaction_unresolved",
    });
  },
);
test("C-29 malformed Cache remains local; incompatible Schema blocks both Repository types", () => {
  const { db, cache, published } = fixture();
  seed(db, "{");
  expect(cache.read("schedule", validator).outcome).toBe("invalid");
  expect(
    published.save("schedule", JSON.stringify({ value: 1 })),
  ).toMatchObject({ outcome: "saved" });
  db.exec("DROP TABLE backend_cache");
  expect(cache.read("schedule", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L3",
  });
  expect(published.read("schedule", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L3",
  });
});
test("C-30 expired Cache still reads found; Module rejects expiration and unknown time without extending TTL", () => {
  const { db, cache } = fixture();
  seed(db);
  const before = row(db);
  const result = cache.read("schedule", validator);
  expect(result.outcome).toBe("found");
  expect(evaluateCacheRead(result, Date.parse(entry().expiresAt))).toEqual({
    outcome: "expired",
  });
  expect(evaluateCacheRead(result, null)).toEqual({ outcome: "time_unknown" });
  expect(evaluateCacheRead(result, Date.parse(entry().expiresAt) - 1)).toEqual({
    outcome: "usable",
    entry: entry(),
  });
  expect(row(db)).toEqual(before);
});
test("C-31 Tx-C failure never rolls back an already committed Published State", () => {
  const { db, cache, published } = fixture();
  published.save("schedule", JSON.stringify({ value: 1 }));
  published.save("schedule", JSON.stringify({ value: 2 }));
  const before = stateImage(db);
  const evidence = token(cache.read("schedule", validator));
  faultCommit(db, false);
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "not_saved",
  });
  expect(stateImage(db)).toEqual(before);
  expect(published.read("schedule", validator)).toMatchObject({
    outcome: "latest",
    generation: 2,
  });
});

test("C-07/C-28 unreadable Transaction flag protects Cache and Published access", () => {
  const { db, logger } = fixture();
  const uncertain = new Proxy(db, {
    get(target, property) {
      if (property === "inTransaction") throw new Error("unknown");
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const cache = new BackendCacheRepository(uncertain, logger);
  const published = new PublishedStateRepository(uncertain, logger);
  expect(cache.read("schedule", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L4",
    reason: "transaction_unresolved",
  });
  expect(published.read("schedule", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L4",
  });
  expect(published.save("schedule", "{}")).toMatchObject({
    outcome: "unknown",
    reason: "transaction_unresolved",
  });
});
test("C-16 unsupported input key is refused before DB operations without consuming valid evidence", () => {
  const { db, cache } = fixture();
  const evidence = token(cache.read("schedule", validator));
  const exec = vi.spyOn(db, "exec");
  expect(() => cache.read("photo" as StateKey, validator)).toThrow(TypeError);
  expect(
    cache.saveConditionally({
      ...request(evidence),
      stateKey: "photo" as StateKey,
    }),
  ).toMatchObject({ outcome: "not_saved", scope: "input" });
  expect(exec).not.toHaveBeenCalled();
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "saved",
  });
});
test("C-15 native WAL writer after read snapshot creates stale evidence, not a torn Cache entry", () => {
  const { db, cache } = fixture();
  seed(db);
  const writer = new Database(db.name);
  opened.push(writer);
  const prepare = db.prepare.bind(db);
  let once = true;
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("SELECT cache_json") && once) {
      once = false;
      writer
        .prepare("UPDATE backend_cache SET cache_json=?")
        .run(JSON.stringify(entry(2)));
    }
    return prepare(sql);
  });
  const result = cache.read("schedule", validator);
  expect(result).toMatchObject({ outcome: "found", entry: entry() });
  expect(cache.saveConditionally(request(token(result), 3))).toMatchObject({
    outcome: "not_saved",
    reason: "stale_cache_evidence",
  });
  expect(row(db)).toEqual({ cache_json: JSON.stringify(entry(2)) });
});
test("C-15 Tx-C CAS holds the actual SQLite writer lock", () => {
  const { db, cache } = fixture();
  const evidence = token(cache.read("schedule", validator));
  const writer = new Database(db.name);
  opened.push(writer);
  writer.pragma("busy_timeout=0");
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE")
      expect(() =>
        writer
          .prepare("INSERT INTO backend_cache VALUES ('schedule','{}')")
          .run(),
      ).toThrow();
    return result;
  });
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "saved",
  });
});
test("C-29 L3 State constraint failure does not block the whole Connection", () => {
  const { db, cache, published } = fixture();
  seed(db);
  const evidence = token(cache.read("schedule", validator));
  const prepare = db.prepare.bind(db);
  let once = true;
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (once && sql.startsWith("INSERT INTO backend_cache")) {
      once = false;
      throw Object.assign(new Error(), { code: "SQLITE_CONSTRAINT_CHECK" });
    }
    return prepare(sql);
  });
  expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
    outcome: "not_saved",
    scope: "state",
    layer: "L3",
  });
  expect(cache.read("currentWeather", validator).outcome).toBe("empty");
  expect(
    published.save("schedule", JSON.stringify({ value: 1 })),
  ).toMatchObject({ outcome: "saved" });
});
test("C-04 non-TEXT bad Cache is invalid with byte-exact replacement evidence", () => {
  const { db, cache } = fixture();
  db.prepare("INSERT INTO backend_cache VALUES ('schedule',?)").run(
    Buffer.from([0, 255, 1]),
  );
  const result = cache.read("schedule", validator);
  expect(result).toMatchObject({ outcome: "invalid", stage: "schema" });
  expect(cache.saveConditionally(request(token(result)))).toMatchObject({
    outcome: "saved",
  });
});
test.each([false, true])(
  "Cache Read COMMIT failure after=%s never issues evidence",
  (after) => {
    const { db, cache } = fixture();
    seed(db);
    faultCommit(db, after);
    const result = cache.read("schedule", validator);
    expect(result).toMatchObject({ outcome: "database_error", layer: "L1" });
    expect(result).not.toHaveProperty("evidence");
    expect(db.inTransaction).toBe(false);
    expect(cache.read("schedule", validator).outcome).toBe("found");
  },
);
test("Cache Rollback completes then throws; final-state proof permits confirmed not-saved", () => {
  const { db, cache } = fixture();
  const evidence = token(cache.read("schedule", validator));
  const exec = db.exec.bind(db);
  let once = true;
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" && once) {
      once = false;
      throw busy();
    }
    const result = exec(sql);
    if (sql === "ROLLBACK") throw busy();
    return result;
  });
  expect(cache.saveConditionally(request(evidence))).toMatchObject({
    outcome: "not_saved",
    layer: "L1",
  });
  expect(db.inTransaction).toBe(false);
  expect(cache.read("schedule", validator).outcome).toBe("empty");
});

test("R35-01/R35-02 successful COMMIT then unreadable Transaction status preserves Attempt and stops all Repositories", () => {
  const { db, logger } = fixture();
  seed(db);
  let armed = false;
  let unavailable = false;
  const exec = db.exec.bind(db);
  const observed = new Proxy(db, {
    get(target, property) {
      if (property === "inTransaction" && unavailable)
        throw new Error("status unavailable");
      if (property === "exec")
        return (sql: string) => {
          const value = exec(sql);
          if (sql === "COMMIT" && armed) unavailable = true;
          return value;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const cache = new BackendCacheRepository(observed, logger);
  const published = new PublishedStateRepository(observed, logger);
  const evidence = token(cache.read("schedule", validator));
  const otherEvidence = token(cache.read("currentWeather", validator));
  armed = true;
  expect(cache.saveConditionally(request(evidence, 2))).toEqual({
    outcome: "unknown",
    scope: "database",
    reason: "transaction_unresolved",
  });
  expect(db.inTransaction).toBe(false);
  expect(row(db)).toEqual({ cache_json: JSON.stringify(entry(2)) });
  // Test-only inspection of an internal map; no production Recovery/reset interface.
  const pending = (
    cache as unknown as {
      pending: Map<
        StateKey,
        { before: { exists: boolean; json: unknown }; planned: string }
      >;
    }
  ).pending;
  expect(pending.get("schedule")).toMatchObject({
    before: { exists: true, json: JSON.stringify(entry()) },
    planned: JSON.stringify(entry(2)),
  });
  expect(connectionCoordination(observed).connectionUnresolved).toBe(true);
  // Even if observation becomes possible again, no automatic recovery is allowed.
  unavailable = false;
  armed = false;
  const prepare = vi.spyOn(db, "prepare");
  const execSpy = vi.spyOn(db, "exec");
  const same = new BackendCacheRepository(observed, logger);
  expect(same.read("schedule", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L4",
    reason: "transaction_unresolved",
  });
  expect(
    same.saveConditionally(request(otherEvidence, 2, "currentWeather")),
  ).toMatchObject({ outcome: "unknown", reason: "transaction_unresolved" });
  expect(same.reconcile("schedule")).toMatchObject({
    outcome: "unknown",
    reason: "transaction_unresolved",
  });
  expect(published.read("schedule", validator)).toMatchObject({
    outcome: "database_error",
    layer: "L4",
  });
  expect(published.save("schedule", "{}")).toMatchObject({
    outcome: "unknown",
    reason: "transaction_unresolved",
  });
  expect(published.reconcile("schedule")).toMatchObject({
    outcome: "unknown",
    reason: "transaction_unresolved",
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(execSpy).not.toHaveBeenCalled();
  expect(pending.has("schedule")).toBe(true);
});
test("R35-01 transient post-COMMIT observation failure requires explicit Row proof within existing reconciliation", () => {
  const { db, logger } = fixture();
  seed(db);
  let armed = false;
  let failures = 0;
  const exec = db.exec.bind(db);
  const observed = new Proxy(db, {
    get(target, property) {
      if (property === "inTransaction" && failures > 0) {
        failures--;
        throw new Error("one observation failed");
      }
      if (property === "exec")
        return (sql: string) => {
          const value = exec(sql);
          if (sql === "COMMIT" && armed) {
            armed = false;
            failures = 1;
          }
          return value;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const cache = new BackendCacheRepository(observed, logger);
  const evidence = token(cache.read("schedule", validator));
  const prepare = vi.spyOn(db, "prepare");
  armed = true;
  expect(cache.saveConditionally(request(evidence, 2))).toEqual({
    outcome: "saved",
    reconciled: true,
  });
  expect(
    prepare.mock.calls.filter(([sql]) => sql.startsWith("SELECT cache_json")),
  ).toHaveLength(2);
  expect(connectionCoordination(observed).connectionUnresolved).toBe(false);
});
test.each([
  "cache_read",
  "cache_save",
  "published_read",
  "published_save",
] as const)(
  "R35-03/R35-04/R35-05/R35-06 toJSON %s reentry is refused without nested operations or token consumption",
  (operation) => {
    const { db, cache, published } = fixture();
    seed(db);
    published.save("schedule", JSON.stringify({ value: 1 }));
    const before = stateImage(db);
    const evidence = token(cache.read("schedule", validator));
    let nested: unknown;
    let calls = 0;
    const candidate = {
      ...entry(2),
      toJSON() {
        calls++;
        expect(db.inTransaction).toBe(false);
        if (operation === "cache_read")
          nested = cache.read("schedule", validator);
        if (operation === "cache_save")
          nested = cache.saveConditionally(request(evidence, 9));
        if (operation === "published_read")
          nested = published.read("schedule", validator);
        if (operation === "published_save")
          nested = published.save(
            "currentWeather",
            JSON.stringify({ value: 9 }),
          );
        return entry(2);
      },
    };
    const result = cache.saveConditionally({
      ...request(evidence, 2),
      entry: candidate,
    });
    expect(nested).toMatchObject({
      outcome: operation.endsWith("read") ? "database_error" : "not_saved",
      reason: "connection_busy",
    });
    expect(result).toEqual({ outcome: "saved", reconciled: false });
    expect(calls).toBe(1);
    expect(row(db)).toEqual({ cache_json: JSON.stringify(entry(2)) });
    expect(stateImage(db)).toEqual(before);
    expect(row(db, "currentWeather")).toBeUndefined();
    expect(connectionCoordination(db).busy).toBe(false);
  },
);
test("R35-07 root toJSON transformation is validated and its exact JSON is reused for Commit proof", () => {
  const { db, cache } = fixture();
  seed(db);
  const evidence = token(cache.read("schedule", validator));
  let calls = 0;
  const candidate = {
    ...entry(2),
    toJSON() {
      calls++;
      return entry(3);
    },
  };
  faultCommit(db, true);
  expect(
    cache.saveConditionally({ ...request(evidence, 2), entry: candidate }),
  ).toEqual({ outcome: "saved", reconciled: true });
  expect(calls).toBe(1);
  expect(row(db)).toEqual({ cache_json: JSON.stringify(entry(3)) });
});
test.each(["version", "timestamp", "missing_data"])(
  "R35-07 transformed %s common-validation failure does not consume evidence",
  (fault) => {
    const { db, cache } = fixture();
    seed(db);
    const evidence = token(cache.read("schedule", validator));
    const before = row(db);
    let calls = 0;
    const candidate = {
      ...entry(2),
      toJSON() {
        calls++;
        if (fault === "version") return { ...entry(3), schemaVersion: 2 };
        if (fault === "timestamp") return { ...entry(3), expiresAt: "bad" };
        return {
          schemaVersion: 1,
          dataUpdatedAt: entry().dataUpdatedAt,
          expiresAt: entry().expiresAt,
        };
      },
    };
    expect(
      cache.saveConditionally({ ...request(evidence, 2), entry: candidate }),
    ).toMatchObject({
      outcome: "not_saved",
      scope: "input",
      reason: "invalid_cache_entry",
    });
    expect(calls).toBe(1);
    expect(row(db)).toEqual(before);
    expect(connectionCoordination(db).busy).toBe(false);
    expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
      outcome: "saved",
    });
  },
);
test("R35-08 toJSON exception leaves DB and evidence intact, releases gate and permits later operations", () => {
  const { db, cache, published } = fixture();
  seed(db);
  const evidence = token(cache.read("schedule", validator));
  const before = row(db);
  const exec = vi.spyOn(db, "exec");
  const candidate = {
    ...entry(2),
    toJSON() {
      expect(db.inTransaction).toBe(false);
      throw new Error("secret serialization failure");
    },
  };
  expect(
    cache.saveConditionally({ ...request(evidence, 2), entry: candidate }),
  ).toMatchObject({
    outcome: "not_saved",
    scope: "input",
    reason: "invalid_cache_entry",
  });
  expect(exec).not.toHaveBeenCalled();
  expect(row(db)).toEqual(before);
  expect(connectionCoordination(db).busy).toBe(false);
  expect(published.save("schedule", "{}")).toMatchObject({ outcome: "saved" });
  expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
    outcome: "saved",
  });
});
test.each(["invalid_input", "reject", "unknown", "fake_evidence"])(
  "R35-08 preflight %s rejection always releases gate and preserves original token",
  (kind) => {
    const { db, cache } = fixture();
    seed(db);
    const evidence = token(cache.read("schedule", validator));
    const candidate = request(evidence, 2);
    if (kind === "invalid_input") candidate.entry.expiresAt = "bad";
    if (kind === "reject") candidate.adoption = { outcome: "reject" };
    if (kind === "unknown") candidate.adoption = { outcome: "unknown" };
    if (kind === "fake_evidence") candidate.evidence = {} as CacheReadEvidence;
    const exec = vi.spyOn(db, "exec");
    expect(cache.saveConditionally(candidate).outcome).toBe("not_saved");
    expect(exec).not.toHaveBeenCalled();
    expect(connectionCoordination(db).busy).toBe(false);
    expect(cache.saveConditionally(request(evidence, 2))).toMatchObject({
      outcome: "saved",
    });
  },
);
