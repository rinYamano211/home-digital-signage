import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { configureDatabase } from "../../src/backend/storage/store.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import { committedStartup } from "../../src/backend/storage/internal/startup-commit.js";
import { StartupTransactionService } from "../../src/backend/storage/startup-transaction.js";
import {
  QuotaRepository,
  type QuotaAttempt,
} from "../../src/backend/storage/quota-repository.js";
import { RuntimeHistory } from "../../src/backend/quota/internal/runtime-history.js";
import {
  HistoryRangeRepository,
  inspectConfirmedRange,
} from "../../src/backend/storage/history-range-repository.js";
import { ClockTrustMonitor } from "../../src/backend/send/internal/trust.js";
import { TOMORROW_IO } from "../../src/backend/quota/quota-guard.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import type { ExclusiveLock } from "../../src/backend/storage/lock.js";
import type { DrainBoundaryEvidence } from "../../src/backend/quota/internal/history-boundaries.js";
const ports = vi.hoisted(() => ({
  drain: new WeakMap<object, unknown>(),
  wait: new WeakMap<object, unknown>(),
  provision: new WeakMap<object, unknown>(),
}));
// Test-only issuance, not a production constructor option or exported issuer.
vi.mock("../../src/backend/quota/internal/history-boundaries.js", () => ({
  inspectDrainEvidence: (p: object) => ports.drain.get(p) ?? null,
  inspectWaitEvidence: (p: object) => ports.wait.get(p) ?? null,
  inspectProvisioningEvidence: (p: object) => ports.provision.get(p) ?? null,
}));
vi.mock("../../src/backend/time/boot-id.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/time/boot-id.js")>()),
  readOsBootId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
}));
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];
const dbs: Database.Database[] = [];
const trust = () => ({
  clockTrusted: true,
  historyTimestampsTrusted: true,
  historyComplete: true,
});
function fixture(start = true, provisioned = true) {
  const dir = mkdtempSync(join(tmpdir(), "signage-history-runtime-"));
  dirs.push(dir);
  const db = new Database(join(dir, "signage.db"));
  dbs.push(db);
  initializeSchema(db);
  configureDatabase(db, 3);
  db.exec(LIFECYCLE_DDL);
  db.prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,1)").run(
    boot,
  );
  db.pragma("user_version=3");
  if (provisioned)
    db.exec(
      "INSERT INTO provider_quota_metadata VALUES ('tomorrow.io','ACTIVE',0,0)",
    );
  const lock = {
    directory: dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock;
  const startup = new StartupTransactionService(db, lock);
  if (start)
    expect(startup.execute({ bootId: boot })).toEqual({
      outcome: "committed",
      generation: 2,
    });
  let wall = 200000000,
    mono = 0n;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  const clock = new ClockTrustMonitor(
    { wallMs: () => wall, monotonicNs: () => mono },
    () => ({ confirmed: true, checkedAtNs: mono }),
  );
  clock.observe();
  const repository = new QuotaRepository(db, 3);
  const runtime = new RuntimeHistory(db, repository, clock);
  const ranges = new HistoryRangeRepository(db, runtime);
  const advance = (ms: number) => {
    wall += ms;
    mono += BigInt(ms) * 1000000n;
    clock.observe();
  };
  const request = () => ({
    providerKey: TOMORROW_IO,
    attempt: repository.beginAttempt(TOMORROW_IO),
    trust,
  });
  return {
    db,
    clock,
    repository,
    runtime,
    ranges,
    advance,
    request,
    startup,
    wall: () => wall,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) {
    if (db.open) {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function reserveRaw(f: ReturnType<typeof fixture>) {
  const q = f.request();
  const r = f.repository.reserve(q);
  expect(r.outcome).toBe("saved");
  f.repository.endAttempt(q.attempt);
  return r;
}
function drain(
  f: ReturnType<typeof fixture>,
  candidate: { rangeId: number; startSequence: number; endSequence: number },
  lastSequence = candidate.endSequence,
): DrainBoundaryEvidence {
  const proof = Object.freeze({});
  ports.drain.set(proof, {
    ...f.runtime.scope(),
    startSequence: candidate.startSequence,
    endSequence: candidate.endSequence,
    lastSequence,
  });
  return proof as DrainBoundaryEvidence;
}
const candidate = { rangeId: 1, startSequence: 1, endSequence: 1 };
function pendingRange() {
  const f = fixture();
  reserveRaw(f);
  f.runtime.freeze();
  return f;
}
const busy = () =>
  Object.assign(Error("private path"), { code: "SQLITE_BUSY" });

test("Actual Startup + saved Tx-Q + same Attempt/Connection and Clock interval register Valid facts", () => {
  const f = fixture();
  const q = f.request();
  const result = f.runtime.reserve(q);
  expect(result.reservation.outcome).toBe("saved");
  expect(result.registered).toBe(true);
  expect(f.runtime.facts()).toEqual([
    {
      ...f.runtime.scope(),
      sequence: 1,
      reservedAtMs: f.wall(),
      reservationOutcome: "saved",
      clockTrustedAtReservation: true,
    },
  ]);
  expect(f.runtime.register(result.reservation, q.attempt)).toBe(false);
  f.repository.endAttempt(q.attempt);
  expect(f.runtime.facts()).toHaveLength(1);
});
test("Saved result from outside the Clock-bound operation cannot be promoted using current Clock alone", () => {
  const f = fixture();
  const q = f.request();
  const result = f.repository.reserve(q);
  expect(result.outcome).toBe("saved");
  expect(f.runtime.register(result, q.attempt)).toBe(false);
  expect(f.runtime.facts()).toEqual([]);
});
test("Plain Startup result or missing actual Startup cannot create Runtime authority", () => {
  const f = fixture(false);
  expect(f.runtime.scope()).toBeNull();
  expect(f.runtime.reserve(f.request()).registered).toBe(false);
});
test("UNPROVISIONED NULL without authenticated Runtime Provisioning is not cutoff zero", () => {
  const f = fixture(true, false);
  expect(f.runtime.effectiveCutoff()).toBeNull();
  expect(f.runtime.reserve(f.request()).reservation.outcome).toBe(
    "quota_blocked",
  );
});
test("Other Repository Connection cannot borrow Startup authorization", () => {
  const f = fixture();
  const other = fixture();
  expect(() => new RuntimeHistory(f.db, other.repository, f.clock)).toThrow();
  expect(
    f.runtime.register(
      { outcome: "saved", evidence: {} as never, reconciled: false },
      {} as QuotaAttempt,
    ),
  ).toBe(false);
});
test("Forged Evidence, wrong Attempt and copied saved result are rejected", () => {
  const f = fixture();
  const q = f.request();
  const result = f.runtime.reserve(q);
  expect(result.registered).toBe(true);
  if (result.reservation.outcome !== "saved") throw Error();
  expect(
    f.runtime.register(
      { ...result.reservation, evidence: {} as never },
      q.attempt,
    ),
  ).toBe(false);
  expect(f.runtime.register(result.reservation, {} as QuotaAttempt)).toBe(
    false,
  );
});
test("Connection close or changed current Generation invalidates Runtime context", () => {
  const f = fixture();
  f.db.exec("UPDATE backend_lifecycle SET generation=3");
  expect(f.runtime.scope()).toBeNull();
  expect(f.runtime.reserve(f.request()).registered).toBe(false);
});
test("Freeze is irreversible on the Connection and preserves immutable prior facts", () => {
  const f = fixture();
  f.runtime.reserve(f.request());
  const before = f.runtime.facts();
  f.runtime.freeze();
  expect(
    f.runtime.reserve({ providerKey: TOMORROW_IO, attempt: {} as never, trust })
      .registered,
  ).toBe(false);
  expect(f.runtime.facts()).toEqual(before);
  expect(Object.isFrozen(before[0])).toBe(true);
  expect(() => new RuntimeHistory(f.db, f.repository, f.clock)).toThrow();
});
test("Clock invalidation after Commit prevents Valid registration, without cancelling the reservation", () => {
  const f = fixture();
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "COMMIT") f.clock.stop();
    return r;
  });
  const result = f.runtime.reserve(f.request());
  expect(result.reservation.outcome).toBe("saved");
  expect(result.registered).toBe(false);
  expect(f.runtime.facts()).toEqual([]);
  expect(
    f.db.prepare("SELECT count(*) AS n FROM provider_quota_consumptions").get(),
  ).toEqual({ n: 1 });
});
test("Clock untrusted at reservation is not replaced by request.trust true", () => {
  const f = fixture();
  f.clock.stop();
  const exec = vi.spyOn(f.db, "exec");
  expect(f.runtime.reserve(f.request()).registered).toBe(false);
  expect(exec).not.toHaveBeenCalled();
});
test("COMMIT-after-throw reconciliation may register only the original Clock-bound Attempt", () => {
  const f = fixture();
  const exec = f.db.exec.bind(f.db);
  let once = true;
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "COMMIT" && once) {
      once = false;
      throw busy();
    }
    return r;
  });
  const result = f.runtime.reserve(f.request());
  expect(result.reservation).toMatchObject({
    outcome: "saved",
    reconciled: true,
  });
  expect(result.registered).toBe(true);
});
test("Unknown -> explicit read-only reconcile saved keeps original Clock binding", () => {
  const f = fixture();
  const exec = f.db.exec.bind(f.db);
  const prepare = f.db.prepare.bind(f.db);
  let committed = false;
  let failRead = true;
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "COMMIT" && !committed) {
      committed = true;
      throw busy();
    }
    return r;
  });
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (
      committed &&
      failRead &&
      sql.startsWith("SELECT provider_key,history_status")
    ) {
      throw busy();
    }
    return prepare(sql);
  }) as typeof f.db.prepare);
  const q = f.request();
  const first = f.runtime.reserve(q);
  expect(first.reservation.outcome).toBe("unknown");
  expect(first.registered).toBe(false);
  expect(f.runtime.facts()).toEqual([]);
  failRead = false;
  const result = f.runtime.reconcile(q.attempt);
  expect(result.reservation).toMatchObject({
    outcome: "saved",
    reconciled: true,
  });
  expect(result.registered).toBe(true);
});
test("Old Clock epoch cannot register after invalidation, even after stable recovery", () => {
  const f = fixture();
  const exec = f.db.exec.bind(f.db);
  let once = true;
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "COMMIT" && once) {
      once = false;
      f.clock.stop();
    }
    return r;
  });
  const q = f.request();
  const r = f.runtime.reserve(q);
  expect(r.registered).toBe(false);
  for (let i = 0; i < 14; i++) f.advance(5000);
  expect(f.clock.state()).toBe("TRUSTED");
  expect(f.runtime.register(r.reservation, q.attempt)).toBe(false);
});
test("Range overlap prevents Valid registration even with a genuine saved reservation", () => {
  const f = fixture();
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "COMMIT")
      f.db.exec(
        "INSERT INTO history_uncertain_ranges VALUES ('tomorrow.io',2,1,1,1)",
      );
    return r;
  });
  const result = f.runtime.reserve(f.request());
  expect(result.reservation.outcome).toBe("saved");
  expect(result.registered).toBe(false);
});
test("Confirmed Drain + frozen Runtime insert one Range and return opaque Commit evidence", () => {
  const f = pendingRange();
  const sql = vi.spyOn(f.db, "exec");
  const result = f.ranges.insert(candidate, drain(f, candidate));
  expect(result.outcome).toBe("saved");
  expect(sql.mock.calls.map((c) => c[0])).toEqual([
    "BEGIN IMMEDIATE",
    "COMMIT",
  ]);
  if (result.outcome !== "saved") throw Error();
  expect(inspectConfirmedRange(result.evidence)).toMatchObject({
    ...f.runtime.scope(),
    ...candidate,
    committed: true,
  });
  expect(f.ranges.read()).toMatchObject({
    outcome: "read",
    ranges: [{ ...candidate }],
  });
});
test("Production boundary has no issuers; arbitrary drained:true is not accepted", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/backend/quota/internal/history-boundaries.js")
  >("../../src/backend/quota/internal/history-boundaries.js");
  expect(actual.inspectDrainEvidence({ drained: true } as never)).toBeNull();
  expect(actual.inspectWaitEvidence({ complete: true } as never)).toBeNull();
  expect(
    actual.inspectProvisioningEvidence({ committed: true } as never),
  ).toBeNull();
  const f = pendingRange();
  const exec = vi.spyOn(f.db, "exec");
  expect(f.ranges.insert(candidate, { drained: true } as never)).toMatchObject({
    outcome: "rejected",
    reason: "drain_unverified",
  });
  expect(exec).not.toHaveBeenCalled();
});
for (const c of [
  { ...candidate, rangeId: 0 },
  { ...candidate, startSequence: 0 },
  { ...candidate, startSequence: 2 },
  { ...candidate, endSequence: 2 },
  { ...candidate, rangeId: 1.5 },
])
  test(`Invalid Range ${JSON.stringify(c)} fails closed`, () => {
    const f = pendingRange();
    expect(f.ranges.insert(c, drain(f, c, 1)).outcome).toBe("rejected");
    expect(
      f.db.prepare("SELECT * FROM history_uncertain_ranges").all(),
    ).toEqual([]);
  });
test("Existing Range ID reuse/overlap is rejected without UPDATE or DELETE", () => {
  const f = pendingRange();
  expect(f.ranges.insert(candidate, drain(f, candidate)).outcome).toBe("saved");
  expect(f.ranges.insert(candidate, drain(f, candidate)).outcome).toBe(
    "rejected",
  );
  expect(
    f.db.prepare("SELECT count(*) AS n FROM history_uncertain_ranges").get(),
  ).toEqual({ n: 1 });
});
test("Valid overlap, missing classifications and stale Drain lastSequence are rejected", () => {
  const f = fixture();
  const q = f.request();
  expect(f.runtime.reserve(q).registered).toBe(true);
  f.runtime.freeze();
  expect(f.ranges.insert(candidate, drain(f, candidate)).outcome).toBe(
    "rejected",
  );
});
test("Unclassified Consumption may be read but cannot be hidden by a partial Range", () => {
  const f = fixture();
  reserveRaw(f);
  f.advance(3001);
  reserveRaw(f);
  const read = f.ranges.read();
  expect(read).toEqual({ outcome: "read", ranges: [] });
  expect(read).not.toHaveProperty("evidence");
  expect(read).not.toHaveProperty("classification");
  expect(read).not.toHaveProperty("historyComplete");
  expect(read).not.toHaveProperty("allowed");
  f.runtime.freeze();
  expect(f.ranges.insert(candidate, drain(f, candidate, 2)).outcome).toBe(
    "rejected",
  );
});
test("Unfrozen Runtime or mismatched Drain Scope cannot register", () => {
  const f = fixture();
  reserveRaw(f);
  expect(f.ranges.insert(candidate, drain(f, candidate)).outcome).toBe(
    "rejected",
  );
  f.runtime.freeze();
  const token = drain(f, candidate);
  ports.drain.set(token, {
    ...f.runtime.scope(),
    ...candidate,
    lastSequence: 1,
    processInstanceId: "previous",
  });
  expect(f.ranges.insert(candidate, token).outcome).toBe("rejected");
});
for (const after of [false, true])
  test(`Range COMMIT ${after ? "after" : "before"} exception returns unknown, no evidence and shared blocking`, () => {
    const f = pendingRange();
    const proof = drain(f, candidate);
    const exec = f.db.exec.bind(f.db);
    vi.spyOn(f.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") {
        if (after) exec(sql);
        throw busy();
      }
      return exec(sql);
    });
    const r = f.ranges.insert(candidate, proof);
    expect(r).toMatchObject({ outcome: "unknown" });
    expect(r).not.toHaveProperty("evidence");
    expect(connectionCoordination(f.db).blocked?.layer).toBe("L4");
    expect(f.ranges.insert(candidate, proof).outcome).toBe("database_error");
    expect(
      f.db.prepare("SELECT count(*) AS n FROM history_uncertain_ranges").get(),
    ).toEqual({ n: after ? 1 : 0 });
  });
test("Range INSERT failure rolls back with no partial row", () => {
  const f = pendingRange();
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.startsWith("INSERT INTO history_uncertain_ranges")) throw busy();
    return prepare(sql);
  }) as typeof f.db.prepare);
  expect(f.ranges.insert(candidate, drain(f, candidate))).toMatchObject({
    outcome: "database_error",
    layer: "L1",
  });
  expect(f.db.inTransaction).toBe(false);
  expect(f.db.prepare("SELECT * FROM history_uncertain_ranges").all()).toEqual(
    [],
  );
});
for (const key of ["busy", "connectionUnresolved"] as const)
  test(`Shared ${key} prohibits new Range Transaction`, () => {
    const f = pendingRange();
    connectionCoordination(f.db)[key] = true;
    const exec = vi.spyOn(f.db, "exec");
    expect(f.ranges.insert(candidate, drain(f, candidate)).outcome).toBe(
      "database_error",
    );
    expect(exec).not.toHaveBeenCalled();
  });
test("Changed Startup Boundary refuses Range registration, not a model-only claim", () => {
  const f = pendingRange();
  const token = drain(f, candidate);
  f.db.exec("UPDATE startup_provider_boundaries SET cutoff_sequence=1");
  expect(f.ranges.insert(candidate, token).outcome).toBe("rejected");
});

test("Clock invalidation during the last ownership check still prevents registration", () => {
  const f = fixture();
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.startsWith("SELECT 1 FROM history_uncertain_ranges"))
      f.clock.stop();
    return prepare(sql);
  }) as typeof f.db.prepare);
  const result = f.runtime.reserve(f.request());
  expect(result.reservation.outcome).toBe("saved");
  expect(result.registered).toBe(false);
});
test("Runtime freeze during reservation callback prevents both promotion and a new Valid claim", () => {
  const f = fixture();
  const q = f.request();
  const result = f.runtime.reserve({
    ...q,
    trust: () => {
      f.runtime.freeze();
      return trust();
    },
  });
  expect(result.registered).toBe(false);
  expect(f.runtime.facts()).toEqual([]);
});
test("Range BEGIN failure may roll back only the attempted Transaction and returns no proof", () => {
  const f = pendingRange();
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql === "BEGIN IMMEDIATE") throw busy();
    return exec(sql);
  });
  expect(f.ranges.insert(candidate, drain(f, candidate))).toMatchObject({
    outcome: "database_error",
    layer: "L1",
  });
  expect(f.db.inTransaction).toBe(false);
});
test("Range Rollback failure keeps shared unresolved protection", () => {
  const f = pendingRange();
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.startsWith("INSERT INTO history_uncertain_ranges")) throw busy();
    return prepare(sql);
  }) as typeof f.db.prepare);
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    if (sql === "ROLLBACK") throw busy();
    return exec(sql);
  });
  expect(f.ranges.insert(candidate, drain(f, candidate))).toMatchObject({
    outcome: "database_error",
    reason: "transaction_unresolved",
  });
  expect(connectionCoordination(f.db)).toMatchObject({
    connectionUnresolved: true,
    blocked: { layer: "L4" },
  });
});
test("Range Rollback-after-success fatal error blocks health even when Transaction ended", () => {
  const f = pendingRange();
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.startsWith("INSERT INTO history_uncertain_ranges")) throw busy();
    return prepare(sql);
  }) as typeof f.db.prepare);
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "ROLLBACK")
      throw Object.assign(Error("private"), { code: "SQLITE_CORRUPT" });
    return r;
  });
  expect(f.ranges.insert(candidate, drain(f, candidate))).toMatchObject({
    outcome: "database_error",
    layer: "L3",
  });
  expect(f.db.inTransaction).toBe(false);
  expect(connectionCoordination(f.db).blocked?.layer).toBe("L3");
});
test("Current DB history, not a fixed complete flag, detects missing and extra provider rows", () => {
  const f = pendingRange();
  const p = drain(f, candidate);
  f.db.exec("UPDATE provider_quota_metadata SET last_sequence=2");
  expect(f.ranges.insert(candidate, p).outcome).toBe("rejected");
});
test("Range success proof cannot be reused after Connection closes", () => {
  const f = pendingRange();
  const r = f.ranges.insert(candidate, drain(f, candidate));
  expect(r.outcome).toBe("saved");
  if (r.outcome !== "saved") throw Error();
  f.db.close();
  expect(inspectConfirmedRange(r.evidence)).toBeNull();
});
test("Confirmed partial Range can end before drained lastSequence when the tail is Valid", () => {
  const f = fixture();
  reserveRaw(f);
  f.advance(3001);
  const q = f.request();
  expect(f.runtime.reserve(q).registered).toBe(true);
  f.runtime.freeze();
  expect(f.ranges.insert(candidate, drain(f, candidate, 2)).outcome).toBe(
    "saved",
  );
});

test("Previous Connection/process evidence cannot register in a fresh Startup Generation", () => {
  const f = fixture();
  const q = f.request();
  const saved = f.runtime.reserve(q);
  const path = f.db.name;
  f.db.close();
  const db = new Database(path);
  dbs.push(db);
  configureDatabase(db, 3);
  const startup = new StartupTransactionService(db, {
    assertHeld: () => {},
  } as unknown as ExclusiveLock);
  expect(startup.execute({ bootId: boot })).toEqual({
    outcome: "committed",
    generation: 3,
  });
  const runtime = new RuntimeHistory(db, new QuotaRepository(db, 3), f.clock);
  expect(runtime.register(saved.reservation, q.attempt)).toBe(false);
  expect(runtime.facts()).toEqual([]);
});
test("Actual persisted Timestamp must still match the committed reservation", () => {
  const f = fixture();
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "COMMIT")
      exec(
        "UPDATE provider_quota_consumptions SET reserved_at_ms=reserved_at_ms+1",
      );
    return r;
  });
  const result = f.runtime.reserve(f.request());
  expect(result.reservation.outcome).toBe("saved");
  expect(result.registered).toBe(false);
});
test("Unowned existing Transaction remains active and unresolved for all writers", () => {
  const f = pendingRange();
  const proof = drain(f, candidate);
  f.db.exec("BEGIN");
  const exec = vi.spyOn(f.db, "exec");
  expect(f.ranges.insert(candidate, proof)).toMatchObject({
    outcome: "database_error",
    reason: "transaction_unresolved",
  });
  expect(exec).not.toHaveBeenCalled();
  expect(f.db.inTransaction).toBe(true);
});
test("Malformed candidate is rejected, not interpreted as a read operation", () => {
  const f = pendingRange();
  expect(f.ranges.insert(null as never, {} as never)).toEqual({
    outcome: "rejected",
    reason: "invalid_range_input",
  });
});

test("Busy Connection prevents Runtime reserve/reconcile reads before ownership", () => {
  const f = fixture();
  const q = f.request();
  connectionCoordination(f.db).busy = true;
  const prepare = vi.spyOn(f.db, "prepare");
  expect(f.runtime.reserve(q).registered).toBe(false);
  expect(f.runtime.reconcile(q.attempt).registered).toBe(false);
  expect(prepare).not.toHaveBeenCalled();
});
test("Already-saved Attempt does not reconcile a different pending reservation", () => {
  const f = fixture();
  const q = f.request();
  expect(f.runtime.reserve(q).registered).toBe(true);
  const reconcile = vi.spyOn(f.repository, "reconcile");
  expect(f.runtime.reconcile(q.attempt).registered).toBe(false);
  expect(reconcile).not.toHaveBeenCalled();
});

for (const failure of ["read_error", "invalid_snapshot"] as const)
  test(`Startup Commit completed but memory evidence recording ${failure} is never adopted`, () => {
    const f = fixture(false);
    const original = f.db.prepare.bind(f.db);
    const exec = vi.spyOn(f.db, "exec");
    vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
      if (
        sql ===
        "SELECT * FROM startup_provider_boundaries WHERE generation=? ORDER BY provider_key"
      ) {
        if (failure === "read_error") throw busy();
        // Let the real handoff validation reject a missing snapshot after Commit.
        return original(
          "SELECT * FROM startup_provider_boundaries WHERE generation=? AND 0",
        );
      }
      return original(sql);
    }) as typeof f.db.prepare);
    expect(f.startup.execute({ bootId: boot })).toEqual({
      outcome: "unknown",
      reason: "startup_commit_unknown",
    });
    expect(f.db.inTransaction).toBe(false);
    expect(
      f.db.prepare("SELECT generation,state FROM backend_lifecycle").get(),
    ).toEqual({ generation: 2, state: "RUNNING" });
    expect(
      f.db.prepare("SELECT count(*) AS n FROM startup_generations").get(),
    ).toEqual({ n: 1 });
    expect(
      f.db
        .prepare("SELECT count(*) AS n FROM startup_provider_boundaries")
        .get(),
    ).toEqual({ n: 1 });
    expect(exec.mock.calls.map((c) => c[0])).toEqual([
      "BEGIN IMMEDIATE",
      "COMMIT",
    ]);
    expect(committedStartup(f.db)).toBeNull();
    expect(committedStartup(f.db)).toBeNull();
    expect(f.startup.execute({ bootId: boot })).toEqual({
      outcome: "rejected",
      reason: "startup_already_attempted",
    });
    expect(exec.mock.calls.map((c) => c[0])).toEqual([
      "BEGIN IMMEDIATE",
      "COMMIT",
    ]);
    expect(f.runtime.scope()).toBeNull();
    expect(f.runtime.facts()).toEqual([]);
  });
test("Reconcile saved without Runtime registration retains consumption and returns no permission", () => {
  const f = fixture();
  const exec = f.db.exec.bind(f.db);
  const prepare = f.db.prepare.bind(f.db);
  let committed = false;
  let failRead = true;
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const r = exec(sql);
    if (sql === "COMMIT" && !committed) {
      committed = true;
      throw busy();
    }
    return r;
  });
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (
      committed &&
      failRead &&
      sql.startsWith("SELECT provider_key,history_status")
    )
      throw busy();
    return prepare(sql);
  }) as typeof f.db.prepare);
  const q = f.request();
  const first = f.runtime.reserve(q);
  expect(first.reservation.outcome).toBe("unknown");
  expect(first.registered).toBe(false);
  failRead = false;
  f.clock.stop();
  const result = f.runtime.reconcile(q.attempt);
  expect(result.reservation).toMatchObject({
    outcome: "saved",
    reconciled: true,
  });
  expect(result.registered).toBe(false);
  expect(f.runtime.facts()).toEqual([]);
  expect(result).not.toHaveProperty("permit");
  expect(result).not.toHaveProperty("allowed");
  expect(
    f.db
      .prepare(
        "SELECT sequence,reserved_at_ms FROM provider_quota_consumptions",
      )
      .all(),
  ).toEqual([{ sequence: 1, reserved_at_ms: f.wall() }]);
  expect(
    f.db.prepare("SELECT last_sequence FROM provider_quota_metadata").get(),
  ).toEqual({ last_sequence: 1 });
});

test.each([false, true])(
  "B43-03 Freeze preserves read-only resolution (%s: committed)",
  (committedAtFailure) => {
    const f = fixture();
    const exec = f.db.exec.bind(f.db);
    const prepare = f.db.prepare.bind(f.db);
    let committed = false;
    let failRead = true;
    vi.spyOn(f.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT" && !committed) {
        committed = true;
        if (committedAtFailure) exec(sql);
        throw busy();
      }
      return exec(sql);
    });
    vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
      if (
        committed &&
        failRead &&
        sql.startsWith("SELECT provider_key,history_status")
      ) {
        throw busy();
      }
      return prepare(sql);
    }) as typeof f.db.prepare);
    const q = f.request();
    const first = f.runtime.reserve(q);
    expect(first.reservation.outcome).toBe("unknown");
    expect(first.registered).toBe(false);
    expect(f.runtime.facts()).toEqual([]);
    f.runtime.freeze();
    const unresolved = f.runtime.reconcile(q.attempt);
    expect(unresolved.reservation.outcome).toBe("unknown");
    expect(unresolved.registered).toBe(false);
    failRead = false;
    const result = f.runtime.reconcile(q.attempt);
    expect(result.reservation.outcome).toBe(
      committedAtFailure ? "saved" : "not_saved",
    );
    expect(result.registered).toBe(false);
    expect(f.runtime.isFrozen()).toBe(true);
    expect(f.runtime.facts()).toEqual([]);
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions")
        .get(),
    ).toEqual({ n: committedAtFailure ? 1 : 0 });
    const writes = vi.spyOn(f.db, "exec").mockClear();
    expect(f.runtime.reserve(q).reservation.outcome).toBe("quota_blocked");
    expect(writes).not.toHaveBeenCalled();
  },
);
