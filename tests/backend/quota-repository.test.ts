import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  QuotaRepository,
  type QuotaAttempt,
  type QuotaReservationEvidence,
  type QuotaProvisioningConfirmation,
} from "../../src/backend/storage/quota-repository.js";
import {
  TOMORROW_IO,
  type QuotaTrust,
} from "../../src/backend/quota/quota-guard.js";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { configureDatabase } from "../../src/backend/storage/store.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import { PublishedStateRepository } from "../../src/backend/storage/published-state-repository.js";
import { AcquisitionControlRepository } from "../../src/backend/storage/acquisition-control-repository.js";
const NOW = 200000000;
const opened: Database.Database[] = [];
const dirs: string[] = [];
const trust: QuotaTrust = {
  clockTrusted: true,
  historyTimestampsTrusted: true,
  historyComplete: true,
};
const confirmation: QuotaProvisioningConfirmation = {
  clockTrusted: true,
  pastUseOutsideQuotaPeriodsConfirmed: true,
  safetyMarginConfirmed: true,
  exclusiveKeyUseConfirmed: true,
};
function fixture(provisioned = true) {
  const dir = mkdtempSync(join(tmpdir(), "signage-quota-"));
  dirs.push(dir);
  const path = join(dir, "signage.db");
  const db = new Database(path);
  opened.push(db);
  configureDatabase(db);
  initializeSchema(db);
  const repo = new QuotaRepository(db);
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  if (provisioned)
    expect(repo.provisionProvider(TOMORROW_IO, confirmation)).toEqual({
      outcome: "initialized",
    });
  clock.mockReturnValue(NOW);
  return { db, path, repo, clock };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function request(repo: QuotaRepository) {
  const attempt = repo.beginAttempt(TOMORROW_IO);
  return { providerKey: TOMORROW_IO, attempt, trust: () => trust };
}
const rows = (db: Database.Database) =>
  db
    .prepare("SELECT * FROM provider_quota_consumptions ORDER BY sequence")
    .safeIntegers(true)
    .all();
const metadata = (db: Database.Database) =>
  db.prepare("SELECT * FROM provider_quota_metadata").safeIntegers(true).all();
const busy = () =>
  Object.assign(new Error("private detail"), { code: "SQLITE_BUSY" });
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
test("TQ-01 Commit atomically adds Sequence, Row, Metadata and opaque Evidence", () => {
  const f = fixture();
  const req = request(f.repo);
  const sql = vi.spyOn(f.db, "exec");
  const result = f.repo.reserve(req);
  expect(result.outcome).toBe("saved");
  expect(sql.mock.calls.map(([s]) => s)).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  expect(rows(f.db)).toEqual([
    { provider_key: TOMORROW_IO, sequence: 1n, reserved_at_ms: BigInt(NOW) },
  ]);
  expect(metadata(f.db)[0]).toMatchObject({ last_sequence: 1n });
  if (result.outcome !== "saved") throw new Error();
  expect(Reflect.ownKeys(result.evidence)).toEqual([]);
  expect(Object.isFrozen(result.evidence)).toBe(true);
  expect(f.repo.inspectReservation(result.evidence, req.attempt)).toMatchObject(
    { sequence: 1, reservedAtMs: NOW },
  );
});
test.each([
  "clockTrusted",
  "pastUseOutsideQuotaPeriodsConfirmed",
  "safetyMarginConfirmed",
  "exclusiveKeyUseConfirmed",
] as const)("KEY-01 F-01 requires explicit %s", (field) => {
  const f = fixture(false);
  expect(
    f.repo.provisionProvider(TOMORROW_IO, { ...confirmation, [field]: false }),
  ).toMatchObject({ outcome: "not_initialized" });
  expect(metadata(f.db)).toEqual([]);
});
test("no implicit activation or reset on inspect/start/reserve", () => {
  const f = fixture(false);
  expect(f.repo.inspect(TOMORROW_IO, trust)).toMatchObject({ allowed: false });
  expect(f.repo.reserve(request(f.repo))).toMatchObject({
    outcome: "quota_blocked",
    reason: "invalid_metadata",
  });
  expect(metadata(f.db)).toEqual([]);
});
test("explicit provisioning cannot reset existing ACTIVE or SUSPENDED history", () => {
  const f = fixture();
  const req = request(f.repo);
  f.repo.reserve(req);
  f.db
    .prepare("UPDATE provider_quota_metadata SET history_status='SUSPENDED'")
    .run();
  const before = rows(f.db);
  expect(f.repo.provisionProvider(TOMORROW_IO, confirmation)).toMatchObject({
    outcome: "not_initialized",
  });
  expect(rows(f.db)).toEqual(before);
  expect(metadata(f.db)[0]).toMatchObject({
    history_status: "SUSPENDED",
    last_sequence: 1n,
  });
});
test.each([
  "clockTrusted",
  "historyTimestampsTrusted",
  "historyComplete",
] as const)("CLK-03 preflight %s false writes nothing", (field) => {
  const f = fixture();
  const req = request(f.repo);
  const exec = vi.spyOn(f.db, "exec");
  expect(
    f.repo.reserve({ ...req, trust: () => ({ ...trust, [field]: false }) }),
  ).toMatchObject({ outcome: "quota_blocked" });
  expect(exec).not.toHaveBeenCalled();
  expect(rows(f.db)).toEqual([]);
});
test("TQ-01 Trust is rechecked inside Transaction before writes", () => {
  const f = fixture();
  const req = request(f.repo);
  let checks = 0;
  expect(
    f.repo.reserve({
      ...req,
      trust: () =>
        ++checks === 1 ? trust : { ...trust, historyComplete: false },
    }),
  ).toMatchObject({ outcome: "quota_blocked", reason: "history_incomplete" });
  expect(checks).toBe(2);
  expect(rows(f.db)).toEqual([]);
});
test("transaction rereads Metadata after it changed since preflight", () => {
  const f = fixture();
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "BEGIN IMMEDIATE")
      f.db
        .prepare(
          "UPDATE provider_quota_metadata SET history_status='SUSPENDED'",
        )
        .run();
    return r;
  });
  expect(f.repo.reserve(request(f.repo))).toMatchObject({
    outcome: "quota_blocked",
    reason: "provider_suspended",
  });
  expect(rows(f.db)).toEqual([]);
});
test("QH-05 quota shortage has no INSERT/UPDATE or Control mutation", () => {
  const f = fixture();
  f.db
    .prepare("INSERT INTO acquisition_control VALUES ('schedule',?)")
    .run('{"consecutiveFailures":3,"nextAttemptAt":"2026-01-01T00:00:00Z"}');
  const first = request(f.repo);
  expect(f.repo.reserve(first).outcome).toBe("saved");
  f.repo.endAttempt(first.attempt);
  const before = rows(f.db);
  const control = f.db.prepare("SELECT * FROM acquisition_control").all();
  const prepare = vi.spyOn(f.db, "prepare");
  expect(f.repo.reserve(request(f.repo))).toMatchObject({
    outcome: "quota_blocked",
    reason: "quota_exhausted",
    recheckAtMs: NOW + 3001,
  });
  expect(
    prepare.mock.calls.some(([s]) => /^(INSERT|UPDATE|DELETE)/.test(s)),
  ).toBe(false);
  expect(rows(f.db)).toEqual(before);
  expect(f.db.prepare("SELECT * FROM acquisition_control").all()).toEqual(
    control,
  );
});
test("a new reservation after inclusive boundary gets next Sequence, never deletes history", () => {
  const f = fixture();
  const a = request(f.repo);
  f.repo.reserve(a);
  f.repo.endAttempt(a.attempt);
  f.clock.mockReturnValue(NOW + 3001);
  expect(f.repo.reserve(request(f.repo)).outcome).toBe("saved");
  expect(rows(f.db)).toHaveLength(2);
  expect(metadata(f.db)[0]).toMatchObject({ last_sequence: 2n });
});
test.each([
  "SUSPENDED",
  "missing",
  "gap",
  "count",
  "future",
  "unsafe_integer",
  "real_timestamp",
])("QH-01/02/03 bad history %s is Fail Closed and unchanged", (fault) => {
  const f = fixture();
  if (fault === "SUSPENDED")
    f.db.exec("UPDATE provider_quota_metadata SET history_status='SUSPENDED'");
  if (fault === "missing") f.db.exec("DELETE FROM provider_quota_metadata");
  if (fault === "count")
    f.db.exec("UPDATE provider_quota_metadata SET last_sequence=1");
  if (["gap", "future", "unsafe_integer", "real_timestamp"].includes(fault)) {
    f.db
      .prepare("INSERT INTO provider_quota_consumptions VALUES (?,?,?)")
      .run(
        TOMORROW_IO,
        fault === "gap" ? 2 : 1,
        fault === "future"
          ? NOW + 1
          : fault === "unsafe_integer"
            ? 9007199254740992n
            : fault === "real_timestamp"
              ? 1.5
              : NOW,
      );
    f.db.exec("UPDATE provider_quota_metadata SET last_sequence=1");
  }
  const before = rows(f.db);
  expect(f.repo.reserve(request(f.repo)).outcome).toBe("quota_blocked");
  expect(rows(f.db)).toEqual(before);
});
test.each([-1, NaN, Infinity, 0.5])(
  "invalid captured Timestamp %s has no Transaction",
  (now) => {
    const f = fixture();
    f.clock.mockReturnValue(now);
    const exec = vi.spyOn(f.db, "exec");
    expect(f.repo.reserve(request(f.repo)).outcome).toBe("quota_blocked");
    expect(exec).not.toHaveBeenCalled();
  },
);
test("F-02 origin precedes Date.now and remains unchanged through COMMIT", () => {
  const f = fixture();
  const req = request(f.repo);
  const events: string[] = [];
  let mono = 100n;
  const hr = vi.spyOn(process.hrtime, "bigint").mockImplementation(() => {
    events.push("mono");
    return mono;
  });
  f.clock.mockImplementation(() => {
    events.push("wall");
    return NOW;
  });
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    events.push(sql);
    if (sql === "COMMIT") mono = 900000000n;
    return exec(sql);
  });
  const result = f.repo.reserve(req);
  hr.mockRestore();
  expect(events.slice(0, 3)).toEqual(["mono", "wall", "BEGIN IMMEDIATE"]);
  if (result.outcome !== "saved") throw new Error();
  expect(
    f.repo.inspectReservation(result.evidence, req.attempt)!
      .measurementStartedNs,
  ).toBe(100n);
});
test.each([false, true])(
  "TQ-03 COMMIT exception after=%s proves result without replay",
  (after) => {
    const f = fixture();
    const req = request(f.repo);
    const spy = failCommit(f.db, after);
    expect(f.repo.reserve(req).outcome).toBe(after ? "saved" : "not_saved");
    expect(f.db.inTransaction).toBe(false);
    expect(rows(f.db)).toHaveLength(after ? 1 : 0);
    expect(
      spy.mock.calls.filter(([s]) => s === "BEGIN IMMEDIATE"),
    ).toHaveLength(1);
  },
);
test("partial INSERT/Metadata failure rolls back atomically", () => {
  const f = fixture();
  const prepare = f.db.prepare.bind(f.db);
  const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("UPDATE provider_quota_metadata"))
      throw Object.assign(new Error(), { code: "SQLITE_CONSTRAINT" });
    return prepare(sql);
  });
  expect(f.repo.reserve(request(f.repo))).toMatchObject({
    outcome: "not_saved",
    scope: "provider",
  });
  expect(rows(f.db)).toEqual([]);
  expect(metadata(f.db)[0]).toMatchObject({ last_sequence: 0n });
  expect(connectionCoordination(f.db).blocked).toBeUndefined();
  spy.mockRestore();
});
test("BEGIN failure never writes or reuses the attempt", () => {
  const f = fixture();
  const req = request(f.repo);
  const exec = f.db.exec.bind(f.db);
  const spy = vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql === "BEGIN IMMEDIATE") throw busy();
    return exec(sql);
  });
  expect(f.repo.reserve(req).outcome).toBe("not_saved");
  spy.mockRestore();
  expect(f.repo.reserve(req)).toMatchObject({
    outcome: "not_saved",
    reason: "invalid_quota_attempt",
  });
  expect(rows(f.db)).toEqual([]);
});
test("TQ-03 reconciliation can stay unknown then finish Read-only", () => {
  const f = fixture();
  const req = request(f.repo);
  const exec = f.db.exec.bind(f.db);
  let commit = true;
  let readFails = true;
  const spy = vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" && commit) {
      commit = false;
      exec(sql);
      throw busy();
    }
    if (sql === "BEGIN" && readFails) throw busy();
    return exec(sql);
  });
  expect(f.repo.reserve(req).outcome).toBe("unknown");
  expect(f.repo.inspect(TOMORROW_IO, trust)).toMatchObject({
    allowed: false,
    reason: "commit_result_unknown",
  });
  expect(f.repo.reconcile(TOMORROW_IO).outcome).toBe("unknown");
  readFails = false;
  spy.mockClear();
  const result = f.repo.reconcile(TOMORROW_IO);
  expect(result.outcome).toBe("saved");
  expect(spy.mock.calls.map(([s]) => s)).toEqual(["BEGIN", "COMMIT"]);
  if (result.outcome !== "saved") throw new Error();
  expect(
    f.repo.inspectReservation(result.evidence, req.attempt)!.reservedAtMs,
  ).toBe(NOW);
});
test("same Row/Sequence plus ABA is not proof of this Commit", () => {
  const f = fixture();
  const req = request(f.repo);
  failCommit(f.db, true, () =>
    f.db
      .prepare(
        "UPDATE provider_quota_consumptions SET reserved_at_ms=reserved_at_ms",
      )
      .run(),
  );
  expect(f.repo.reserve(req)).toMatchObject({
    outcome: "unknown",
    reason: "quota_writer_not_excluded",
  });
  expect(f.repo.reconcile(TOMORROW_IO).outcome).toBe("unknown");
});
test("external Connection rewrite/restore prevents false reconciliation", () => {
  const f = fixture();
  const other = new Database(f.path);
  opened.push(other);
  failCommit(f.db, true, () => {
    other.exec(
      "UPDATE provider_quota_consumptions SET reserved_at_ms=reserved_at_ms+1; UPDATE provider_quota_consumptions SET reserved_at_ms=reserved_at_ms-1;",
    );
  });
  expect(f.repo.reserve(request(f.repo)).outcome).toBe("unknown");
});
test("unresolved Transaction protects all repositories, without opening another Tx", () => {
  const f = fixture();
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT" || sql === "ROLLBACK") throw busy();
    return exec(sql);
  });
  expect(f.repo.reserve(request(f.repo))).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
  expect(
    new PublishedStateRepository(f.db).save("schedule", "{}"),
  ).toMatchObject({ outcome: "unknown", scope: "database" });
  expect(new AcquisitionControlRepository(f.db).read("schedule")).toMatchObject(
    { outcome: "database_error" },
  );
  expect(f.repo.reconcile(TOMORROW_IO)).toMatchObject({
    outcome: "unknown",
    scope: "database",
  });
});
test("Commit success followed by unreadable status never issues evidence", () => {
  const f = fixture();
  let unknown = false;
  const proxy = new Proxy(f.db, {
    get(target, p) {
      if (p === "inTransaction" && unknown) throw new Error();
      const v = Reflect.get(target, p, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const repo = new QuotaRepository(proxy);
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "COMMIT") unknown = true;
    return r;
  });
  const result = repo.reserve(request(repo));
  expect(result).toMatchObject({ outcome: "unknown", scope: "database" });
  expect("evidence" in result).toBe(false);
  expect(
    new PublishedStateRepository(proxy).save("schedule", "{}").outcome,
  ).toBe("unknown");
});
test("single-use Attempt, overlapping begin and forged Attempt rejected", () => {
  const f = fixture();
  const req = request(f.repo);
  expect(() => f.repo.beginAttempt(TOMORROW_IO)).toThrow();
  expect(f.repo.reserve({ ...req, attempt: {} as QuotaAttempt }).outcome).toBe(
    "not_saved",
  );
  expect(f.repo.reserve(req).outcome).toBe("saved");
  expect(f.repo.reserve(req).outcome).toBe("not_saved");
  expect(rows(f.db)).toHaveLength(1);
});
test("reentrant/another Repository calls observe shared busy gate", () => {
  const f = fixture();
  const other = new QuotaRepository(f.db);
  const second = request(other);
  const req = request(f.repo);
  let n = 0;
  const source = () => {
    n++;
    expect(other.reserve(second)).toMatchObject({
      outcome: "not_saved",
      reason: "connection_busy",
    });
    return trust;
  };
  expect(f.repo.reserve({ ...req, trust: source }).outcome).toBe("saved");
  expect(n).toBe(2);
});
test("reservation evidence is not transferable or recoverable from a Sequence", () => {
  const f = fixture();
  const req = request(f.repo);
  const result = f.repo.reserve(req);
  if (result.outcome !== "saved") throw new Error();
  expect(
    f.repo.inspectReservation({} as QuotaReservationEvidence, req.attempt),
  ).toBeNull();
  expect(
    f.repo.inspectReservation({ ...result.evidence }, req.attempt),
  ).toBeNull();
  const other = new QuotaRepository(f.db);
  const token = other.beginAttempt(TOMORROW_IO);
  expect(other.inspectReservation(result.evidence, token)).toBeNull();
  f.repo.endAttempt(req.attempt);
  expect(f.repo.inspectReservation(result.evidence, req.attempt)).toBeNull();
  expect(rows(f.db)).toHaveLength(1);
});
test("closed/reopened Connection loses old evidence; history persists with independent trust required", () => {
  const f = fixture();
  const req = request(f.repo);
  const result = f.repo.reserve(req);
  if (result.outcome !== "saved") throw new Error();
  f.db.close();
  expect(f.repo.inspectReservation(result.evidence, req.attempt)).toBeNull();
  const db = new Database(f.path);
  opened.push(db);
  configureDatabase(db);
  const repo = new QuotaRepository(db);
  const fresh = request(repo);
  expect(repo.inspectReservation(result.evidence, fresh.attempt)).toBeNull();
  expect(
    repo.reserve({
      ...fresh,
      trust: () => ({ ...trust, historyComplete: false }),
    }).outcome,
  ).toBe("quota_blocked");
  expect(rows(db)).toHaveLength(1);
});
test("TQ-04 ended/unsent attempts do not cancel committed consumption", () => {
  const f = fixture();
  const req = request(f.repo);
  expect(f.repo.reserve(req).outcome).toBe("saved");
  f.repo.endAttempt(req.attempt);
  expect(rows(f.db)).toHaveLength(1);
  expect(f.repo.reserve(request(f.repo)).outcome).toBe("quota_blocked");
});

test("initial provisioning COMMIT unknown cannot be followed by a reservation", () => {
  const f = fixture(false);
  failCommit(f.db, true);
  expect(f.repo.provisionProvider(TOMORROW_IO, confirmation)).toMatchObject({
    outcome: "unknown",
  });
  expect(f.repo.reserve(request(f.repo))).toMatchObject({
    outcome: "unknown",
    reason: "provisioning_unconfirmed",
  });
  expect(new QuotaRepository(f.db).inspect(TOMORROW_IO, trust).allowed).toBe(
    false,
  );
  expect(rows(f.db)).toEqual([]);
});
test("unknown reservation blocks another Repository on the same Connection", () => {
  const f = fixture();
  const req = request(f.repo);
  failCommit(f.db, true, () =>
    f.db
      .prepare(
        "UPDATE provider_quota_consumptions SET reserved_at_ms=reserved_at_ms",
      )
      .run(),
  );
  expect(f.repo.reserve(req).outcome).toBe("unknown");
  const other = new QuotaRepository(f.db);
  expect(other.reserve(request(other))).toMatchObject({
    outcome: "unknown",
    reason: "commit_result_unknown",
  });
});
test.each(["clock", "history", "quota", "sql", "unknown"])(
  "Control State stays unchanged for %s suppression/failure",
  (reason) => {
    const f = fixture();
    f.db
      .prepare("INSERT INTO acquisition_control VALUES ('schedule','sentinel')")
      .run();
    let req = request(f.repo);
    if (reason === "quota") {
      f.repo.reserve(req);
      f.repo.endAttempt(req.attempt);
      req = request(f.repo);
    }
    if (reason === "sql") failCommit(f.db, false);
    if (reason === "unknown")
      failCommit(f.db, true, () =>
        f.db
          .prepare(
            "UPDATE provider_quota_consumptions SET reserved_at_ms=reserved_at_ms",
          )
          .run(),
      );
    f.repo.reserve({
      ...req,
      trust: () =>
        reason === "clock"
          ? { ...trust, clockTrusted: false }
          : reason === "history"
            ? { ...trust, historyComplete: false }
            : trust,
    });
    expect(
      f.db.prepare("SELECT control_json FROM acquisition_control").get(),
    ).toEqual({ control_json: "sentinel" });
  },
);

test.each(["initialized_real", "sequence_real", "sequence_unsafe"])(
  "SQLite non-integer/unsafe Metadata %s rejected",
  (fault) => {
    const f = fixture();
    if (fault === "initialized_real")
      f.db.exec("UPDATE provider_quota_metadata SET initialized_at_ms=0.5");
    else
      f.db
        .prepare("UPDATE provider_quota_metadata SET last_sequence=?")
        .run(fault === "sequence_real" ? 0.5 : 9007199254740992n);
    expect(f.repo.reserve(request(f.repo))).toMatchObject({
      outcome: "quota_blocked",
      reason: "invalid_quota_rows",
    });
    expect(rows(f.db)).toEqual([]);
  },
);
test("throwing admin confirmation is unconfirmed, not database corruption", () => {
  const f = fixture(false);
  expect(
    f.repo.provisionProvider(TOMORROW_IO, {
      ...confirmation,
      get clockTrusted(): boolean {
        throw new Error();
      },
    }),
  ).toMatchObject({ outcome: "not_initialized" });
  expect(connectionCoordination(f.db).blocked).toBeUndefined();
});
