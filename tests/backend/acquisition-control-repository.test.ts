import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  AcquisitionControlRepository,
  ControlAttemptManager,
  type AcquisitionControlState,
  type ControlReadEvidence,
  type InitialControlSaveAuthorization,
  type InitialControlFacts,
  type ControlSaveRequest,
  type ControlReadResult,
} from "../../src/backend/storage/acquisition-control-repository.js";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import {
  BackendStore,
  configureDatabase,
} from "../../src/backend/storage/store.js";
import {
  PublishedStateRepository,
  type StateKey,
} from "../../src/backend/storage/published-state-repository.js";
import { BackendCacheRepository } from "../../src/backend/storage/backend-cache-repository.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";

const dirs: string[] = [];
const dbs: Database.Database[] = [];
const state = (failures = 0): AcquisitionControlState => ({
  consecutiveFailures: failures,
  nextAttemptAt: "2026-01-01T00:00:00Z",
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "signage-control-"));
  dirs.push(dir);
  const path = join(dir, "backend.db");
  const db = new Database(path);
  dbs.push(db);
  configureDatabase(db);
  initializeSchema(db);
  const context = new ControlAttemptManager();
  context.beginAttempt("schedule");
  return {
    db,
    path,
    context,
    repo: new AcquisitionControlRepository(db, context),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function seed(
  db: Database.Database,
  value: unknown = state(),
  key = "schedule",
) {
  db.prepare("INSERT INTO acquisition_control VALUES (?,?)").run(
    key,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
function row(db: Database.Database, key = "schedule") {
  return db
    .prepare("SELECT control_json FROM acquisition_control WHERE state_key=?")
    .get(key);
}
function evidence(result: ControlReadResult): ControlReadEvidence {
  if (!("evidence" in result)) throw new Error("Expected evidence");
  return result.evidence;
}
function update(
  token: ControlReadEvidence,
  nextState = state(1),
  stateKey: StateKey = "schedule",
): ControlSaveRequest {
  return { mode: "update", stateKey, evidence: token, nextState };
}
function facts(): InitialControlFacts {
  return {
    httpResult: "success",
    nextState: state(),
    databaseHealthy: true,
    acquisitionConditionsSatisfied: true,
    eligibility: {
      kind: "confirmed_new",
      pastRecordsAbsent: true,
      outsideInitialization: true,
      inputsComplete: true,
      newnessConfirmed: true,
    },
  };
}
function initial(f: ReturnType<typeof fixture>) {
  const token = evidence(f.repo.read("schedule"));
  const authorization = f.context.authorizeInitial(token, facts());
  if (!authorization) throw new Error("Expected authorization");
  return {
    mode: "initialize" as const,
    stateKey: "schedule" as const,
    evidence: token,
    authorization,
    nextState: state(),
  };
}
const busy = () =>
  Object.assign(new Error("private database details"), { code: "SQLITE_BUSY" });
function failCommit(db: Database.Database, after: boolean, hook?: () => void) {
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

test("C2-01 normal past nextAttemptAt is valid and read ends its Transaction", () => {
  const f = fixture();
  seed(f.db);
  const result = f.repo.read("schedule");
  expect(result).toMatchObject({ outcome: "found", state: state() });
  expect(f.db.inTransaction).toBe(false);
  expect(Object.isFrozen(evidence(result))).toBe(true);
  expect(Reflect.ownKeys(evidence(result))).toEqual([]);
});
test("missing is not a newness authorization", () => {
  const f = fixture();
  const result = f.repo.read("schedule");
  expect(result.outcome).toBe("empty");
  expect(
    f.context.authorizeInitial(evidence(result), {
      ...facts(),
      eligibility: { kind: "unknown" },
    }),
  ).toBeNull();
  expect(row(f.db)).toBeUndefined();
});
test.each([
  "broken",
  "[]",
  "null",
  '{"consecutiveFailures":0}',
  '{"consecutiveFailures":"1","nextAttemptAt":"2026-01-01T00:00:00Z"}',
  '{"consecutiveFailures":-1,"nextAttemptAt":"2026-01-01T00:00:00Z"}',
  '{"consecutiveFailures":0.5,"nextAttemptAt":"2026-01-01T00:00:00Z"}',
  '{"consecutiveFailures":9007199254740992,"nextAttemptAt":"2026-01-01T00:00:00Z"}',
  '{"consecutiveFailures":0,"nextAttemptAt":"2026-02-30T00:00:00Z"}',
  '{"consecutiveFailures":0,"nextAttemptAt":"2026-01-01T00:00:00"}',
])("C2-13 invalid Row is local, no evidence and no repair: %s", (json) => {
  const f = fixture();
  seed(f.db, json);
  const result = f.repo.read("schedule");
  expect(result.outcome).toBe("invalid");
  expect("evidence" in result).toBe(false);
  expect(row(f.db)).toEqual({ control_json: json });
  f.context.beginAttempt("currentWeather");
  expect(f.repo.read("currentWeather").outcome).toBe("empty");
});
test("nontext JSON is invalid, not DB-wide failure", () => {
  const f = fixture();
  f.db
    .prepare("INSERT INTO acquisition_control VALUES (?,?)")
    .run("schedule", Buffer.from("{}"));
  expect(f.repo.read("schedule")).toMatchObject({
    outcome: "invalid",
    stage: "schema",
  });
});
test("Allowlist and explicit trial prevent implicit startup acquisition", () => {
  const f = fixture();
  expect(() => f.repo.read("bad" as StateKey)).toThrow(TypeError);
  expect(() => f.repo.read("rainForecast")).toThrow(TypeError);
  expect(
    f.repo.saveConditionally(
      update({} as ControlReadEvidence, state(), "bad" as StateKey),
    ),
  ).toMatchObject({ outcome: "not_saved", scope: "input" });
});
test.each([{}, Object.freeze(Object.create(null))])(
  "C2-03 forged Evidence rejected",
  (forged) => {
    const f = fixture();
    seed(f.db);
    expect(
      f.repo.saveConditionally(update(forged as ControlReadEvidence)),
    ).toMatchObject({
      outcome: "not_saved",
      reason: "invalid_control_evidence",
    });
    expect(row(f.db)).toEqual({ control_json: JSON.stringify(state()) });
  },
);
test("C2-04 Evidence cannot move to another Repository sharing Connection", () => {
  const f = fixture();
  seed(f.db);
  const e = evidence(f.repo.read("schedule"));
  const second = new AcquisitionControlRepository(f.db, f.context);
  expect(second.saveConditionally(update(e))).toMatchObject({
    outcome: "not_saved",
    reason: "invalid_control_evidence",
  });
});
test("C2-04 Evidence cannot move across Connection/State or by copying", () => {
  const f = fixture();
  const g = fixture();
  seed(f.db);
  seed(g.db);
  const e = evidence(f.repo.read("schedule"));
  expect(g.repo.saveConditionally(update(e))).toMatchObject({
    outcome: "not_saved",
  });
  f.context.beginAttempt("currentWeather");
  expect(
    f.repo.saveConditionally(update(e, state(), "currentWeather")),
  ).toMatchObject({ outcome: "not_saved" });
  expect(f.repo.saveConditionally(update({ ...e }))).toMatchObject({
    outcome: "not_saved",
  });
});
test("C2-05 time alone does not expire Evidence", () => {
  const f = fixture();
  seed(f.db);
  const e = evidence(f.repo.read("schedule"));
  vi.useFakeTimers();
  vi.setSystemTime("2099-01-01");
  expect(f.repo.saveConditionally(update(e))).toMatchObject({
    outcome: "saved",
  });
});
test("C2-05 ending trial invalidates Evidence, including a subsequent same-State trial", () => {
  const f = fixture();
  seed(f.db);
  const e = evidence(f.repo.read("schedule"));
  f.context.endAttempt(f.context.current("schedule")!);
  f.context.beginAttempt("schedule");
  expect(f.repo.saveConditionally(update(e))).toMatchObject({
    outcome: "not_saved",
    reason: "invalid_control_evidence",
  });
});
test("C2-04/05 closed/reopened Connection cannot reuse tokens", () => {
  const f = fixture();
  const req = initial(f);
  f.db.close();
  const db = new Database(f.path);
  dbs.push(db);
  const c = new ControlAttemptManager();
  c.beginAttempt("schedule");
  const repo = new AcquisitionControlRepository(db, c);
  expect(repo.saveConditionally(req)).toMatchObject({ outcome: "not_saved" });
});
test("trial overlap is rejected and ended trial cannot affect a later trial", () => {
  const f = fixture();
  const old = f.context.current("schedule")!;
  expect(() => f.context.beginAttempt("schedule")).toThrow();
  f.context.endAttempt(old);
  const next = f.context.beginAttempt("schedule");
  f.context.endAttempt(old);
  expect(f.context.current("schedule")).toBe(next);
});
test("C2-06 unchanged consumes Evidence without UPDATE", () => {
  const f = fixture();
  seed(f.db);
  const req = update(evidence(f.repo.read("schedule")), state());
  const sql = vi.spyOn(f.db, "prepare");
  expect(f.repo.saveConditionally(req)).toEqual({ outcome: "unchanged" });
  expect(
    sql.mock.calls.some(([s]) => s.startsWith("UPDATE acquisition_control")),
  ).toBe(false);
  expect(f.repo.saveConditionally(req)).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_control_evidence",
  });
});
test("C2-06 BEGIN failure consumes Evidence and initial Authorization", () => {
  const f = fixture();
  const req = initial(f);
  const exec = f.db.exec.bind(f.db);
  const spy = vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql === "BEGIN IMMEDIATE") throw busy();
    return exec(sql);
  });
  expect(f.repo.saveConditionally(req)).toMatchObject({ outcome: "not_saved" });
  spy.mockRestore();
  expect(f.repo.saveConditionally(req)).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_control_evidence",
  });
  expect(row(f.db)).toBeUndefined();
});
test("input rejection before BEGIN leaves Evidence reusable", () => {
  const f = fixture();
  seed(f.db);
  const e = evidence(f.repo.read("schedule"));
  expect(
    f.repo.saveConditionally(
      update(e, { ...state(), consecutiveFailures: -1 }),
    ),
  ).toMatchObject({ outcome: "not_saved" });
  expect(f.repo.saveConditionally(update(e))).toMatchObject({
    outcome: "saved",
  });
});
test.each(["databaseHealthy", "acquisitionConditionsSatisfied"] as const)(
  "C2-07 initial authorization requires %s",
  (field) => {
    const f = fixture();
    const e = evidence(f.repo.read("schedule"));
    expect(
      f.context.authorizeInitial(e, { ...facts(), [field]: false }),
    ).toBeNull();
  },
);
test.each([
  "pastRecordsAbsent",
  "outsideInitialization",
  "inputsComplete",
  "newnessConfirmed",
] as const)("C2-02/07 confirmed-new requires %s", (field) => {
  const f = fixture();
  const e = evidence(f.repo.read("schedule"));
  const v = facts();
  if (v.eligibility.kind !== "confirmed_new") throw new Error();
  v.eligibility[field] = false;
  expect(f.context.authorizeInitial(e, v)).toBeNull();
});
test("C2-07 wait path needs affirmative completed wait, plus valid candidate", () => {
  const f = fixture();
  const e = evidence(f.repo.read("schedule"));
  expect(
    f.context.authorizeInitial(e, {
      ...facts(),
      eligibility: { kind: "conservative_wait_complete", waitCompleted: false },
    }),
  ).toBeNull();
  expect(
    f.context.authorizeInitial(e, {
      ...facts(),
      nextState: { ...state(), nextAttemptAt: "invalid" },
    }),
  ).toBeNull();
  expect(
    f.context.authorizeInitial(e, {
      ...facts(),
      eligibility: { kind: "conservative_wait_complete", waitCompleted: true },
    }),
  ).not.toBeNull();
});
test("C2-07 only latest read Evidence can authorize, and presence is rechecked", () => {
  const f = fixture();
  const old = evidence(f.repo.read("schedule"));
  const next = evidence(f.repo.read("schedule"));
  expect(f.context.authorizeInitial(old, facts())).toBeNull();
  seed(f.db);
  expect(f.context.authorizeInitial(next, facts())).toBeNull();
});
test("C2-08/10 fake or other-Evidence Authorization cannot initialize", () => {
  const f = fixture();
  const req = initial(f);
  expect(
    f.repo.saveConditionally({
      ...req,
      authorization: {} as InitialControlSaveAuthorization,
    }),
  ).toMatchObject({
    outcome: "not_saved",
    reason: "invalid_initial_authorization",
  });
  const other = evidence(f.repo.read("schedule"));
  expect(f.repo.saveConditionally({ ...req, evidence: other })).toMatchObject({
    outcome: "not_saved",
    reason: "invalid_initial_authorization",
  });
  expect(f.repo.saveConditionally(req)).toMatchObject({ outcome: "saved" });
  expect(f.repo.saveConditionally(req)).toMatchObject({ outcome: "not_saved" });
});
test.each(["end", "shutdown", "global"])(
  "C2-09 previously issued Authorization expires on %s",
  (how) => {
    const f = fixture();
    const req = initial(f);
    if (how === "end") f.context.endAttempt(f.context.current("schedule")!);
    if (how === "shutdown") f.context.beginShutdown();
    if (how === "global") f.context.blockWrites();
    expect(f.context.authorizeInitial(req.evidence, facts())).toBeNull();
    expect(f.repo.saveConditionally(req)).toMatchObject({
      outcome: "not_saved",
    });
    expect(row(f.db)).toBeUndefined();
  },
);
test("C2-09 Shutdown forbids begin/reissue/INSERT even during valid cleanup deadline", () => {
  const f = fixture();
  const req = initial(f);
  f.context.beginShutdown({
    deadlineMonotonicMs: performance.now() + 10000,
    lifecycleCleanupAllowed: true,
  });
  expect(() => f.context.beginAttempt("rainForecast")).toThrow();
  expect(f.context.authorizeInitial(req.evidence, facts())).toBeNull();
  expect(f.repo.saveConditionally(req)).toMatchObject({ outcome: "not_saved" });
});
test("C2-14 initial INSERT never UPSERTs a concurrently appeared Row", () => {
  const f = fixture();
  const req = initial(f);
  seed(f.db, state(3));
  expect(f.repo.saveConditionally(req)).toMatchObject({
    outcome: "not_saved",
    reason: "stale_control_evidence",
  });
  expect(row(f.db)).toEqual({ control_json: JSON.stringify(state(3)) });
});
test.each(["change", "delete"])(
  "C2-15 UPDATE refuses Row %s since Read",
  (how) => {
    const f = fixture();
    seed(f.db);
    const req = update(evidence(f.repo.read("schedule")));
    if (how === "delete") f.db.exec("DELETE FROM acquisition_control");
    else
      f.db
        .prepare("UPDATE acquisition_control SET control_json=?")
        .run(JSON.stringify(state(3)));
    expect(f.repo.saveConditionally(req)).toMatchObject({
      outcome: "not_saved",
      reason: "stale_control_evidence",
    });
    expect(row(f.db)).toEqual(
      how === "delete" ? undefined : { control_json: JSON.stringify(state(3)) },
    );
  },
);
test("initialize/update modes cannot be interchanged", () => {
  const f = fixture();
  const req = initial(f);
  expect(f.repo.saveConditionally(update(req.evidence))).toMatchObject({
    outcome: "not_saved",
    reason: "wrong_control_save_mode",
  });
  expect(f.repo.saveConditionally(req)).toMatchObject({ outcome: "saved" });
  const e = evidence(f.repo.read("schedule"));
  expect(f.context.authorizeInitial(e, facts())).toBeNull();
  expect(f.repo.saveConditionally({ ...req, evidence: e })).toMatchObject({
    outcome: "not_saved",
    reason: "wrong_control_save_mode",
  });
});
test("C2-16/18 Tx-A uses BEGIN IMMEDIATE, commits exact two-field JSON", () => {
  const f = fixture();
  const req = initial(f);
  const spy = vi.spyOn(f.db, "exec");
  expect(f.repo.saveConditionally(req)).toEqual({
    outcome: "saved",
    reconciled: false,
  });
  expect(spy.mock.calls.map(([s]) => s)).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  expect(row(f.db)).toEqual({ control_json: JSON.stringify(state()) });
});
test.each([false, true])(
  "C2-18 COMMIT exception after=%s is resolved without blind replay",
  (after) => {
    const f = fixture();
    const req = initial(f);
    const spy = failCommit(f.db, after);
    expect(f.repo.saveConditionally(req)).toMatchObject({
      outcome: after ? "saved" : "not_saved",
    });
    expect(f.db.inTransaction).toBe(false);
    expect(row(f.db)).toEqual(
      after ? { control_json: JSON.stringify(state()) } : undefined,
    );
    expect(
      spy.mock.calls.filter(([s]) => s === "BEGIN IMMEDIATE"),
    ).toHaveLength(1);
  },
);
test("C2-16 constraint rollback is local and consumes Evidence", () => {
  const f = fixture();
  seed(f.db);
  const e = evidence(f.repo.read("schedule"));
  const prepare = f.db.prepare.bind(f.db);
  const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("UPDATE acquisition_control"))
      throw Object.assign(new Error(), { code: "SQLITE_CONSTRAINT_CHECK" });
    return prepare(sql);
  });
  expect(f.repo.saveConditionally(update(e))).toMatchObject({
    outcome: "not_saved",
    scope: "state",
  });
  expect(row(f.db)).toEqual({ control_json: JSON.stringify(state()) });
  spy.mockRestore();
  expect(f.repo.saveConditionally(update(e))).toMatchObject({
    outcome: "not_saved",
    reason: "consumed_control_evidence",
  });
  f.context.beginAttempt("rainForecast");
  expect(f.repo.read("rainForecast").outcome).toBe("empty");
});
test("C2-18 rollback notification error is resolved from actual Transaction state", () => {
  const f = fixture();
  const req = initial(f);
  const exec = f.db.exec.bind(f.db);
  let failed = false;
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" && !failed) {
      failed = true;
      throw busy();
    }
    if (sql === "ROLLBACK") {
      exec(sql);
      throw busy();
    }
    return exec(sql);
  });
  expect(f.repo.saveConditionally(req)).toMatchObject({ outcome: "not_saved" });
  expect(f.db.inTransaction).toBe(false);
});
test("C2-19 equal before/planned images remain unknown after COMMIT exception", () => {
  const f = fixture();
  seed(f.db);
  const req = update(evidence(f.repo.read("schedule")), state());
  failCommit(f.db, true);
  expect(f.repo.saveConditionally(req)).toMatchObject({
    outcome: "unknown",
    reason: "indistinguishable_control_images",
  });
  expect(f.repo.read("schedule")).toEqual({
    outcome: "pending",
    reason: "commit_result_unknown",
  });
  expect(f.repo.reconcile("schedule")).toMatchObject({ outcome: "unknown" });
});
test("C2-19 ABA same-JSON extra write is not accepted as our COMMIT proof", () => {
  const f = fixture();
  const req = initial(f);
  failCommit(f.db, true, () =>
    f.db
      .prepare("UPDATE acquisition_control SET control_json=control_json")
      .run(),
  );
  expect(f.repo.saveConditionally(req)).toMatchObject({
    outcome: "unknown",
    reason: "control_writer_not_excluded",
  });
  expect(f.repo.read("schedule").outcome).toBe("pending");
});
test("C2-19 write from another Connection invalidates proof", () => {
  const f = fixture();
  const req = initial(f);
  const other = new Database(f.path);
  dbs.push(other);
  failCommit(f.db, true, () => {
    other
      .prepare("UPDATE acquisition_control SET control_json=?")
      .run(JSON.stringify(state(3)));
    other
      .prepare("UPDATE acquisition_control SET control_json=?")
      .run(JSON.stringify(state()));
  });
  expect(f.repo.saveConditionally(req)).toMatchObject({ outcome: "unknown" });
});
test("C2-20 reconciliation failure leaves pending; later read-only proof can finish", () => {
  const f = fixture();
  const req = initial(f);
  const exec = f.db.exec.bind(f.db);
  let writeCommit = true;
  let failRead = true;
  const spy = vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" && writeCommit) {
      writeCommit = false;
      exec(sql);
      throw busy();
    }
    if (sql === "BEGIN" && failRead) throw busy();
    return exec(sql);
  });
  expect(f.repo.saveConditionally(req)).toMatchObject({ outcome: "unknown" });
  expect(f.repo.read("schedule").outcome).toBe("pending");
  expect(f.repo.saveConditionally(req)).toMatchObject({ outcome: "unknown" });
  expect(f.repo.reconcile("schedule")).toMatchObject({ outcome: "unknown" });
  failRead = false;
  spy.mockClear();
  expect(f.repo.reconcile("schedule")).toEqual({
    outcome: "saved",
    reconciled: true,
  });
  expect(spy.mock.calls.map(([s]) => s)).toEqual(["BEGIN", "COMMIT"]);
  expect(f.repo.read("schedule").outcome).toBe("found");
});
test("C2-21 persistent status unreadability globally protects PR-B and Tx-A", () => {
  const f = fixture();
  seed(f.db);
  let unreadable = false;
  const proxy = new Proxy(f.db, {
    get(target, property) {
      if (property === "inTransaction" && unreadable) throw new Error();
      const v = Reflect.get(target, property, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const repo = new AcquisitionControlRepository(proxy, f.context);
  const req = update(evidence(repo.read("schedule")));
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "COMMIT") unreadable = true;
    return result;
  });
  expect(repo.saveConditionally(req)).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
  expect(repo.read("schedule")).toMatchObject({
    outcome: "database_error",
    reason: "transaction_unresolved",
  });
  const pub = new PublishedStateRepository(proxy);
  expect(pub.save("schedule", "{}")).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
  const cache = new BackendCacheRepository(proxy);
  expect(
    cache.read("schedule", {
      schema: () => ({ valid: true, value: {} }),
      semantic: (v) => ({ valid: true, value: v }),
    }),
  ).toMatchObject({ outcome: "database_error" });
});
test("C2-21 unresolved rollback holds same shared Connection globally", () => {
  const f = fixture();
  const req = initial(f);
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" || sql === "ROLLBACK") throw busy();
    return exec(sql);
  });
  expect(f.repo.saveConditionally(req)).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
  expect(connectionCoordination(f.db).connectionUnresolved).toBe(true);
  expect(f.repo.reconcile("schedule")).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
});
test("fatal Schema mismatch blocks shared storage without altering Schema", () => {
  const f = fixture();
  f.db.pragma("user_version=3");
  expect(f.repo.read("schedule")).toMatchObject({
    outcome: "database_error",
    layer: "L3",
  });
  expect(connectionCoordination(f.db).blocked).toBeDefined();
});
test("existing busy gate rejects Control read and save without touching DB", () => {
  const f = fixture();
  const req = initial(f);
  connectionCoordination(f.db).busy = true;
  const spy = vi.spyOn(f.db, "exec");
  expect(f.repo.read("schedule")).toMatchObject({
    outcome: "database_error",
    reason: "connection_busy",
  });
  expect(f.repo.saveConditionally(req)).toMatchObject({
    outcome: "not_saved",
    reason: "connection_busy",
  });
  expect(spy).not.toHaveBeenCalled();
  connectionCoordination(f.db).busy = false;
});
test("candidate getter reentry cannot access shared Control/PR-B storage", () => {
  const f = fixture();
  seed(f.db);
  const e = evidence(f.repo.read("schedule"));
  const pub = new PublishedStateRepository(f.db);
  const next = {
    get consecutiveFailures() {
      expect(f.repo.read("schedule")).toMatchObject({
        outcome: "database_error",
        reason: "connection_busy",
      });
      expect(pub.save("schedule", "{}")).toMatchObject({
        outcome: "not_saved",
        reason: "connection_busy",
      });
      return 1;
    },
    nextAttemptAt: state().nextAttemptAt,
  };
  expect(f.repo.saveConditionally(update(e, next))).toMatchObject({
    outcome: "saved",
  });
});
test.each([false, true])(
  "C2-25 Shutdown existing UPDATE cleanup allowed=%s",
  (permitted) => {
    let now = 100;
    const context = new ControlAttemptManager(() => now);
    const f = fixture();
    context.beginAttempt("schedule");
    const repo = new AcquisitionControlRepository(f.db, context);
    seed(f.db);
    const req = update(evidence(repo.read("schedule")));
    context.beginShutdown({
      deadlineMonotonicMs: 200,
      lifecycleCleanupAllowed: permitted,
    });
    expect(repo.saveConditionally(req)).toMatchObject({
      outcome: permitted ? "saved" : "not_saved",
    });
    now = 201;
    const e = evidence(repo.read("schedule"));
    expect(repo.saveConditionally(update(e, state(2)))).toMatchObject({
      outcome: "not_saved",
    });
  },
);
test("C2-25 DB safety stop overrides Shutdown cleanup permission", () => {
  const f = fixture();
  seed(f.db);
  const req = update(evidence(f.repo.read("schedule")));
  f.context.beginShutdown({
    deadlineMonotonicMs: performance.now() + 10000,
    lifecycleCleanupAllowed: true,
  });
  f.context.blockWrites();
  expect(f.repo.saveConditionally(req)).toMatchObject({ outcome: "not_saved" });
});
test("request getters run inside gate and are snapshotted once", () => {
  const f = fixture();
  const req = initial(f);
  let calls = 0;
  const wrapped = {
    ...req,
    get stateKey() {
      calls++;
      expect(f.repo.read("schedule")).toMatchObject({
        outcome: "database_error",
        reason: "connection_busy",
      });
      return "schedule" as const;
    },
  };
  expect(f.repo.saveConditionally(wrapped)).toMatchObject({ outcome: "saved" });
  expect(calls).toBe(1);
});

test.each([false, true])(
  "read COMMIT exception after=%s never issues evidence or leaves active Transaction",
  (after) => {
    const f = fixture();
    seed(f.db);
    failCommit(f.db, after);
    const read = f.repo.read("schedule");
    expect(read.outcome).toBe("database_error");
    expect("evidence" in read).toBe(false);
    expect(f.db.inTransaction).toBe(false);
  },
);
test("initial facts cannot be supplied through another Application context", () => {
  const f = fixture();
  const e = evidence(f.repo.read("schedule"));
  const other = new ControlAttemptManager();
  other.beginAttempt("schedule");
  expect(other.authorizeInitial(e, facts())).toBeNull();
});
test("unknown is shared among Control Repositories but healthy other State and PR-B continue", () => {
  const f = fixture();
  seed(f.db);
  const req = update(evidence(f.repo.read("schedule")), state());
  failCommit(f.db, true);
  expect(f.repo.saveConditionally(req).outcome).toBe("unknown");
  const other = new AcquisitionControlRepository(f.db, f.context);
  expect(other.read("schedule").outcome).toBe("pending");
  expect(other.saveConditionally(req).outcome).toBe("unknown");
  f.context.beginAttempt("rainForecast");
  expect(f.repo.read("rainForecast").outcome).toBe("empty");
  expect(
    new PublishedStateRepository(f.db).save("rainForecast", "{}").outcome,
  ).toBe("saved");
});
test("saved candidate is copied once and its JSON is reused after Commit exception", () => {
  const f = fixture();
  seed(f.db);
  let failuresReads = 0;
  let timeReads = 0;
  const next = {
    get consecutiveFailures() {
      failuresReads++;
      return failuresReads;
    },
    get nextAttemptAt() {
      timeReads++;
      return state().nextAttemptAt;
    },
  };
  const req = update(evidence(f.repo.read("schedule")), next);
  failCommit(f.db, true);
  expect(f.repo.saveConditionally(req)).toMatchObject({
    outcome: "saved",
    reconciled: true,
  });
  expect(failuresReads).toBe(1);
  expect(timeReads).toBe(1);
  expect(row(f.db)).toEqual({ control_json: JSON.stringify(state(1)) });
});
test("Shutdown during candidate validation invalidates initial authorization before BEGIN", () => {
  const f = fixture();
  const req = initial(f);
  const next = {
    get consecutiveFailures() {
      f.context.beginShutdown();
      return 0;
    },
    nextAttemptAt: state().nextAttemptAt,
  };
  const exec = vi.spyOn(f.db, "exec");
  expect(f.repo.saveConditionally({ ...req, nextState: next })).toMatchObject({
    outcome: "not_saved",
  });
  expect(exec).not.toHaveBeenCalled();
  expect(row(f.db)).toBeUndefined();
});
test("Authorization re-read failure does not publish a token", () => {
  const f = fixture();
  const e = evidence(f.repo.read("schedule"));
  failCommit(f.db, true);
  expect(f.context.authorizeInitial(e, facts())).toBeNull();
  expect(f.db.inTransaction).toBe(false);
});
test("reconcile without owned pending work never writes", () => {
  const f = fixture();
  const spy = vi.spyOn(f.db, "exec");
  expect(f.repo.reconcile("schedule")).toMatchObject({
    outcome: "not_saved",
    reason: "no_owned_pending_attempt",
  });
  expect(spy).not.toHaveBeenCalled();
});

test("Store composes Control with its existing Connection and remains sole Close owner", () => {
  const f = fixture(); // Constructor composition only; real open/lock paths have existing Process tests.
  const store = Reflect.construct(BackendStore, [f.db]) as BackendStore;
  store.acquisitionControl.context.beginAttempt("schedule");
  const e = evidence(store.acquisitionControl.read("schedule"));
  const authorization = store.acquisitionControl.context.authorizeInitial(
    e,
    facts(),
  );
  expect(authorization).not.toBeNull();
  expect(
    store.acquisitionControl.saveConditionally({
      mode: "initialize",
      stateKey: "schedule",
      evidence: e,
      authorization: authorization!,
      nextState: state(),
    }),
  ).toMatchObject({ outcome: "saved" });
  expect(row(f.db)).toEqual({ control_json: JSON.stringify(state()) });
  store.close();
  expect(f.db.open).toBe(false);
  store.close();
  expect(store.acquisitionControl.read("schedule")).toMatchObject({
    outcome: "database_error",
  });
});

test("initial authorization requires a classified HTTP success or failure, not a generic result", () => {
  const f = fixture();
  const e = evidence(f.repo.read("schedule"));
  expect(
    f.context.authorizeInitial(e, { ...facts(), httpResult: "unclassified" }),
  ).toBeNull();
  expect(
    f.context.authorizeInitial(e, { ...facts(), httpResult: "failure" }),
  ).not.toBeNull();
});

test("throwing initial facts are rejected without blocking healthy storage", () => {
  const f = fixture();
  const e = evidence(f.repo.read("schedule"));
  expect(
    f.context.authorizeInitial(e, {
      ...facts(),
      get nextState(): AcquisitionControlState {
        throw new Error("Application error");
      },
    }),
  ).toBeNull();
  expect(connectionCoordination(f.db).blocked).toBeUndefined();
  f.context.beginAttempt("rainForecast");
  expect(f.repo.read("rainForecast").outcome).toBe("empty");
});
