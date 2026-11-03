import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { configureDatabase } from "../../src/backend/storage/store.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import { StartupTransactionService } from "../../src/backend/storage/startup-transaction.js";
import type { ExclusiveLock } from "../../src/backend/storage/lock.js";
import { QuotaRepository } from "../../src/backend/storage/quota-repository.js";
import { RuntimeHistory } from "../../src/backend/quota/internal/runtime-history.js";
import {
  ClockTrustMonitor,
  HistoryTrustMonitor,
} from "../../src/backend/send/internal/trust.js";
import { ProviderSendGate } from "../../src/backend/send/internal/provider-send-gate.js";
import {
  HistoryRecovery,
  inspectAuthenticatedHistory,
  inspectDrainEvidence,
  inspectWaitEvidence,
  inspectProvisioningEvidence,
  type AuthenticatedHistorySource,
  type HistoryResumeEvidence,
} from "../../src/backend/quota/internal/history-boundaries.js";
import { TOMORROW_IO as provider } from "../../src/backend/quota/quota-guard.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import { HistoryRecheck } from "../../src/backend/quota/internal/history-recheck.js";
const fakeWait = vi.hoisted(() => ({
  read: undefined as
    undefined | (() => { nowNs: bigint; continuity: object } | null),
}));
vi.mock("../../src/backend/quota/internal/wait-clock.js", () => ({
  verifiedWaitReading: () => fakeWait.read?.() ?? null,
}));
vi.mock("../../src/backend/time/boot-id.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/time/boot-id.js")>()),
  readOsBootId: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
}));
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dbs: Database.Database[] = [],
  dirs: string[] = [];
function fixture(old = 0, provisioned = true) {
  const dir = mkdtempSync(join(tmpdir(), "history-recovery-"));
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
  if (provisioned) {
    db.prepare(
      "INSERT INTO provider_quota_metadata VALUES (?,'ACTIVE',0,?)",
    ).run(provider, old);
    for (let i = 1; i <= old; i++)
      db.prepare("INSERT INTO provider_quota_consumptions VALUES (?,?,?)").run(
        provider,
        i,
        i % 2 ? 200000001 : 10,
      );
  }
  const lock = {
    directory: dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock;
  expect(
    new StartupTransactionService(db, lock).execute({ bootId: boot }),
  ).toEqual({ outcome: "committed", generation: 2 });
  let wall = 200000000,
    mono = 0n,
    os = true;
  const continuity = {};
  const time = { wallMs: () => wall, monotonicNs: () => mono };
  fakeWait.read = () => ({ nowNs: mono, continuity });
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => mono);
  const clock = new ClockTrustMonitor(time, () => ({
    confirmed: os,
    checkedAtNs: mono,
  }));
  clock.observe();
  const history = new HistoryTrustMonitor(),
    repo = new QuotaRepository(db, 3),
    runtime = new RuntimeHistory(db, repo, clock);
  let finish = () => {},
    signal: AbortSignal | undefined,
    calls = 0;
  const gate = new ProviderSendGate(
    new Map([[provider, { repository: repo, history }]]),
    clock,
    time,
    {
      start(s, end) {
        calls++;
        signal = s;
        finish = end;
        return Promise.resolve("headers");
      },
    },
  );
  const recovery = new HistoryRecovery(db, repo, runtime, gate, clock);
  const advance = (ms: number, observe = true) => {
    wall += ms;
    mono += BigInt(ms) * 1000000n;
    if (observe) clock.observe();
  };
  const stabilize = () => {
    for (let i = 0; i < 14; i++) advance(5000);
    expect(clock.state()).toBe("TRUSTED");
  };
  const reserve = () => {
    const q = gate.beginAttempt(provider);
    if (!q) throw Error("Gate blocked");
    return {
      ...q,
      ...runtime.reserve({
        providerKey: provider,
        attempt: q.quotaAttempt,
        trust: () => gate.quotaTrust(provider),
      }),
    };
  };
  const rows = () =>
    db
      .prepare(
        "SELECT sequence,reserved_at_ms FROM provider_quota_consumptions ORDER BY sequence",
      )
      .all();
  return {
    db,
    dir,
    lock,
    repo,
    runtime,
    clock,
    history,
    gate,
    recovery,
    time,
    advance,
    stabilize,
    reserve,
    rows,
    finish: () => finish(),
    signal: () => signal,
    calls: () => calls,
    setOs: (v: boolean) => {
      os = v;
    },
    setMono: (v: bigint) => {
      mono = v;
    },
    setWall: (v: number) => {
      wall = v;
    },
    mono: () => mono,
    wall: () => wall,
    continuity,
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fakeWait.read = undefined;
  for (const db of dbs.splice(0)) {
    if (db.open) {
      if (db.inTransaction) db.exec("ROLLBACK");
      db.close();
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function active() {
  const f = fixture();
  expect(f.recovery.recover()).toBe(true);
  return f;
}
function uncertain() {
  const f = active();
  const r = f.reserve();
  expect(r.registered).toBe(true);
  f.gate.endAttempt(r.attempt);
  f.setOs(false);
  f.clock.observe();
  expect(f.recovery.drainAndClassify()).toBe(true);
  return f;
}

test("B43-12/15 startup is closed until authenticated recovery; old Monitor remains UNVERIFIED", () => {
  const f = fixture();
  expect(f.gate.beginAttempt(provider)).toBeNull();
  expect(f.recovery.recover()).toBe(true);
  expect(f.history.state()).toBe("UNVERIFIED");
  expect(
    inspectAuthenticatedHistory(f.recovery.source, f.repo)?.evaluation,
  ).toBe("TRUSTED");
  expect(f.gate.reservationStatus(provider).allowed).toBe(true);
});
test("B43-13/17 real Tx-Q and Gate accept authenticated History while legacy trust fields stay false", () => {
  const f = active(),
    r = f.reserve();
  expect(r.reservation).toEqual(expect.objectContaining({ outcome: "saved" }));
  expect(r.registered).toBe(true);
  expect(f.gate.quotaTrust(provider).historyTimestampsTrusted).toBe(false);
  expect(f.gate.start(r.attempt, r.reservation).kind).toBe("started");
  expect(f.calls()).toBe(1);
  f.finish();
  expect(f.gate.snapshot(provider).phase).toBe("IDLE");
  expect(f.history.state()).toBe("UNVERIFIED");
});
test("B43-08/13 unauthenticated CONSERVATIVE, Drain, Wait and Resume objects grant no authority", () => {
  const f = active();
  expect(
    inspectAuthenticatedHistory(
      { evaluation: "CONSERVATIVE" } as unknown as AuthenticatedHistorySource,
      f.repo,
    ),
  ).toBeNull();
  expect(() => f.gate.bindHistorySource(provider, {} as never)).toThrow();
  expect(inspectWaitEvidence({} as never)).toBeNull();
  expect(inspectDrainEvidence({} as never)).toBeNull();
  expect(inspectProvisioningEvidence({} as never)).toBeNull();
  f.runtime.freeze();
  expect(f.runtime.resumeAfterRecovery({} as HistoryResumeEvidence)).toBe(
    false,
  );
});
test("B43-01/02 Abort or settled headers alone is not Drain; Flight stays occupied", async () => {
  const f = active(),
    r = f.reserve(),
    started = f.gate.start(r.attempt, r.reservation);
  expect(started.kind).toBe("started");
  if (started.kind === "started") await started.response;
  f.setOs(false);
  f.clock.observe();
  expect(f.signal()?.aborted).toBe(true);
  expect(f.runtime.isFrozen()).toBe(true);
  expect(f.gate.snapshot(provider).phase).toBe("ABORT_REQUESTED");
  expect(f.recovery.drainAndClassify()).toBe(false);
  expect(f.recovery.waitEvidence()).toEqual([]);
  f.finish();
  expect(f.recovery.drainAndClassify()).toBe(true);
  expect(f.rows()).toHaveLength(1);
});
test("B43-01 Clock invalidation during Tx-Q preserves committed consumption, denies registration and HTTP", () => {
  const f = active();
  const q = f.gate.beginAttempt(provider)!;
  const exec = f.db.exec.bind(f.db);
  let writing = false;
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const out = exec(sql);
    if (sql === "BEGIN IMMEDIATE") writing = true;
    if (sql === "COMMIT" && writing) {
      writing = false;
      f.setOs(false);
      f.clock.observe();
    }
    return out;
  });
  const r = f.runtime.reserve({
    providerKey: provider,
    attempt: q.quotaAttempt,
    trust: () => f.gate.quotaTrust(provider),
  });
  expect(r.reservation.outcome).toBe("saved");
  expect(r.registered).toBe(false);
  expect(f.gate.start(q.attempt, r.reservation).kind).toBe("blocked");
  expect(f.calls()).toBe(0);
  expect(f.rows()).toHaveLength(1);
});
test("B43-04/07 Drain commits fixed uncertain suffix and conservatively counts reversed/future timestamps", () => {
  const f = uncertain();
  expect(f.runtime.facts()).toEqual([]);
  expect(
    f.db
      .prepare(
        "SELECT start_sequence,end_sequence FROM history_uncertain_ranges",
      )
      .get(),
  ).toEqual({ start_sequence: 1, end_sequence: 1 });
  f.db
    .prepare("UPDATE provider_quota_consumptions SET reserved_at_ms=?")
    .run(f.wall() + 10000000);
  f.setOs(true);
  f.stabilize();
  expect(f.recovery.recover()).toBe(true);
  expect(
    inspectAuthenticatedHistory(f.recovery.source, f.repo)?.evaluation,
  ).toBe("CONSERVATIVE");
  expect(f.history.state()).toBe("UNVERIFIED");
});
test("B43-05 Freeze-before Trial and reservation never revive after recovery", () => {
  const f = active(),
    r = f.reserve();
  f.gate.endAttempt(r.attempt);
  f.setOs(false);
  f.clock.observe();
  expect(f.recovery.drainAndClassify()).toBe(true);
  f.setOs(true);
  f.stabilize();
  expect(f.recovery.recover()).toBe(true);
  expect(f.runtime.register(r.reservation, r.quotaAttempt)).toBe(false);
  expect(f.gate.start(r.attempt, r.reservation).kind).toBe("blocked");
  expect(f.runtime.facts()).toEqual([]);
});
test("B43-06 Range COMMIT unknown retains rows, emits no Wait and protects Connection", () => {
  const f = active(),
    r = f.reserve();
  f.gate.endAttempt(r.attempt);
  f.recovery.suspend();
  const exec = f.db.exec.bind(f.db);
  let rangeWrite = false;
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.startsWith("INSERT INTO history_uncertain_ranges"))
      rangeWrite = true;
    return prepare(sql);
  }) as typeof f.db.prepare);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const out = exec(sql);
    if (sql === "COMMIT" && rangeWrite)
      throw Object.assign(Error("private"), { code: "SQLITE_BUSY" });
    return out;
  });
  expect(f.recovery.drainAndClassify()).toBe(false);
  expect(connectionCoordination(f.db).blocked).toBeDefined();
  expect(f.recovery.waitEvidence()).toEqual([]);
  expect(f.rows()).toHaveLength(1);
  expect(f.gate.beginAttempt(provider)).toBeNull();
});
test.each(["sequence", "timestamp", "scope"])(
  "B43-08/13 changed %s after History evaluation is rejected, not repaired",
  (kind) => {
    const f = active();
    expect(
      inspectAuthenticatedHistory(f.recovery.source, f.repo),
    ).not.toBeNull();
    if (kind === "sequence")
      f.db.exec("UPDATE provider_quota_metadata SET last_sequence=1");
    else if (kind === "timestamp")
      f.db.exec("UPDATE provider_quota_metadata SET initialized_at_ms=-1");
    else f.db.exec("UPDATE backend_lifecycle SET generation=3");
    expect(inspectAuthenticatedHistory(f.recovery.source, f.repo)).toBeNull();
    expect(f.gate.beginAttempt(provider)).toBeNull();
    expect(f.calls()).toBe(0);
  },
);
test("B43-13 latest Tx-Q history is re-read inside BEGIN IMMEDIATE", () => {
  const f = active(),
    q = f.gate.beginAttempt(provider)!;
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE")
      exec("UPDATE provider_quota_metadata SET last_sequence=1");
    return result;
  });
  const r = f.runtime.reserve({
    providerKey: provider,
    attempt: q.quotaAttempt,
    trust: () => f.gate.quotaTrust(provider),
  });
  expect(r.reservation.outcome).toBe("quota_blocked");
  expect(r.registered).toBe(false);
  expect(f.rows()).toEqual([]);
  expect(
    f.db.prepare("SELECT last_sequence FROM provider_quota_metadata").get(),
  ).toEqual({ last_sequence: 0 });
});
test("B43-09/17 independently authenticated 1m wait permits CONSERVATIVE resume before 65m/25h", () => {
  const f = fixture(1);
  expect(f.recovery.recover()).toBe(false);
  const proof = f.recovery.waitEvidence();
  f.advance(59999, false);
  expect(f.recovery.recover()).toBe(false);
  f.advance(1, false);
  f.stabilize();
  expect(f.recovery.recover()).toBe(true);
  const values = proof.map(inspectWaitEvidence).filter((v) => v !== null);
  expect(
    values.find((v) => v.windowMs === 1000)!.elapsedNs,
  ).toBeGreaterThanOrEqual(60000000000n);
  expect(values.find((v) => v.windowMs === 86400000)!.elapsedNs).toBeLessThan(
    90000000000000n,
  );
  expect(f.history.state()).toBe("UNVERIFIED");
  const r = f.reserve();
  expect(r.registered).toBe(true);
  expect(f.gate.start(r.attempt, r.reservation).kind).toBe("started");
  f.finish();
});
test.each([60000, 3900000, 90000000])(
  "B43-09 exact Window Wait boundary %i is independently retained",
  (duration) => {
    const f = fixture(1);
    f.recovery.drainAndClassify();
    const proofs = f.recovery.waitEvidence();
    f.advance(duration - 1, false);
    const before = proofs
      .map(inspectWaitEvidence)
      .find(
        (p) =>
          p?.windowMs ===
          (duration === 60000
            ? 1000
            : duration === 3900000
              ? 3600000
              : 86400000),
      )!;
    expect(before.elapsedNs).toBe(BigInt(duration - 1) * 1000000n);
    f.advance(1, false);
    expect(
      proofs
        .map(inspectWaitEvidence)
        .find((p) => p?.windowMs === before.windowMs)!.elapsedNs,
    ).toBe(BigInt(duration) * 1000000n);
  },
);
test("B43-10 long GC/I-O observation gap and Clock epoch loss preserve healthy monotonic Wait", () => {
  const f = uncertain(),
    proofs = f.recovery.waitEvidence();
  f.advance(3900000, false);
  expect(f.clock.state()).toBe("SUSPENDED");
  expect(proofs.map(inspectWaitEvidence).every((p) => p !== null)).toBe(true);
  expect(
    proofs.some((p) => inspectWaitEvidence(p)!.elapsedNs >= 3900000000000n),
  ).toBe(true);
});
test.each(["backwards", "throws", "malformed", "continuity"])(
  "B43-11 %s invalidates old Wait and restart uses a new origin",
  (kind) => {
    const f = fixture(1);
    f.recovery.drainAndClassify();
    const proofs = f.recovery.waitEvidence();
    f.advance(30000, false);
    if (kind === "backwards") f.setMono(-1n);
    else if (kind === "throws")
      fakeWait.read = () => {
        throw Error("clock");
      };
    else if (kind === "malformed")
      fakeWait.read = () => ({
        nowNs: 1 as unknown as bigint,
        continuity: f.continuity,
      });
    else fakeWait.read = () => ({ nowNs: f.mono(), continuity: {} });
    expect(proofs.every((p) => inspectWaitEvidence(p) === null)).toBe(true);
    f.setMono(100000000000n);
    fakeWait.read = () => ({ nowNs: f.mono(), continuity: f.continuity });
    const next = f.recovery.waitEvidence();
    expect(next.length).toBeGreaterThan(0);
    expect(next.every((p) => inspectWaitEvidence(p)?.elapsedNs === 0n)).toBe(
      true,
    );
    expect(proofs.every((p) => inspectWaitEvidence(p) === null)).toBe(true);
  },
);
test("B43-11 production assurance unavailable never excludes old history", () => {
  const f = fixture(1);
  fakeWait.read = () => null;
  expect(f.recovery.recover()).toBe(false);
  f.advance(90000000, false);
  f.stabilize();
  expect(f.recovery.waitEvidence()).toEqual([]);
  expect(f.recovery.recover()).toBe(false);
  expect(f.gate.beginAttempt(provider)).toBeNull();
});
test("B43-12 F-01 actual Commit receipt, not empty Startup, authorizes runtime cutoff 0", () => {
  const f = fixture(0, false);
  expect(f.recovery.confirmRuntimeProvisioning()).toBeNull();
  expect(f.runtime.effectiveCutoff()).toBeNull();
  expect(
    f.repo.provisionProvider(provider, {
      clockTrusted: true,
      pastUseOutsideQuotaPeriodsConfirmed: true,
      safetyMarginConfirmed: true,
      exclusiveKeyUseConfirmed: true,
    }),
  ).toEqual({ outcome: "initialized" });
  expect(f.recovery.confirmRuntimeProvisioning()).not.toBeNull();
  expect(f.runtime.scope()?.cutoffSequence).toBeNull();
  expect(f.runtime.effectiveCutoff()).toBe(0);
  expect(f.recovery.recover()).toBe(true);
});
test("B43-12 empty copied Metadata cannot forge F-01 receipt", () => {
  const f = fixture(0, false);
  f.db.exec(
    "INSERT INTO provider_quota_metadata VALUES ('tomorrow.io','ACTIVE',0,0)",
  );
  expect(f.recovery.confirmRuntimeProvisioning()).toBeNull();
  expect(f.recovery.recover()).toBe(false);
});
test.each([
  [20, 60000],
  [400, 3900000],
])(
  "B43-14 limiting history %i blocks new quota and never changes Control State",
  (count, waited) => {
    const f = fixture(count);
    f.recovery.drainAndClassify();
    f.advance(waited, false);
    f.stabilize();
    expect(f.recovery.recover()).toBe(false);
    expect(f.gate.beginAttempt(provider)).toBeNull();
    expect(f.db.prepare("SELECT * FROM acquisition_control").all()).toEqual([]);
    expect(f.rows()).toHaveLength(count);
  },
);
test("B43-15 Clock recovery never releases Recovery or independent management stop", () => {
  const f = active(),
    management = f.gate.stopControl(provider);
  management.stop();
  f.setOs(false);
  f.clock.observe();
  f.setOs(true);
  f.stabilize();
  expect(f.gate.beginAttempt(provider)).toBeNull();
  expect(f.runtime.isFrozen()).toBe(true);
  expect(f.recovery.recover()).toBe(true);
  expect(f.gate.beginAttempt(provider)).toBeNull();
  management.release();
  expect(f.gate.beginAttempt(provider)).not.toBeNull();
});
test("B43-15 Clock invalidation during final Recovery confirmation cannot release the new stop", () => {
  const f = fixture();
  const state = f.clock.state.bind(f.clock);
  let reads = 0;
  vi.spyOn(f.clock, "state").mockImplementation(() => {
    if (++reads === 2) {
      f.setOs(false);
      f.clock.observe();
    }
    return state();
  });
  expect(f.recovery.recover()).toBe(false);
  expect(f.runtime.isFrozen()).toBe(true);
  expect(f.gate.beginAttempt(provider)).toBeNull();
});
test("B43-16/17 successful normal restart uses new Cutoff, rejects old source and needs no admin quarantine", () => {
  const f = active(),
    r = f.reserve();
  f.gate.endAttempt(r.attempt);
  const old = f.recovery.source;
  f.db.close();
  const db = new Database(join(f.dir, "signage.db"));
  dbs.push(db);
  configureDatabase(db, 3);
  expect(
    new StartupTransactionService(db, f.lock).execute({ bootId: boot }),
  ).toEqual({ outcome: "committed", generation: 3 });
  const repo = new QuotaRepository(db, 3),
    runtime = new RuntimeHistory(db, repo, f.clock),
    history = new HistoryTrustMonitor();
  const gate = new ProviderSendGate(
    new Map([[provider, { repository: repo, history }]]),
    f.clock,
    f.time,
  );
  const recovery = new HistoryRecovery(db, repo, runtime, gate, f.clock);
  expect(inspectAuthenticatedHistory(old, repo)).toBeNull();
  expect(runtime.register(r.reservation, r.quotaAttempt)).toBe(false);
  expect(runtime.scope()?.cutoffSequence).toBe(1);
  expect(recovery.recover()).toBe(false);
  f.advance(60000, false);
  f.stabilize();
  expect(recovery.recover()).toBe(true);
  expect(history.state()).toBe("UNVERIFIED");
});
test("B43-17 all Waits completed permits recovery without converting uncertain timestamps to Valid", () => {
  const f = uncertain();
  f.advance(90000000, false);
  f.setOs(true);
  f.stabilize();
  expect(f.recovery.recover()).toBe(true);
  expect(f.runtime.facts()).toEqual([]);
  expect(
    f.db.prepare("SELECT * FROM history_uncertain_ranges").all(),
  ).toHaveLength(1);
  const next = f.reserve();
  expect(next.registered).toBe(true);
  expect(f.gate.start(next.attempt, next.reservation).kind).toBe("started");
  f.finish();
});
test("B43-17 A/B/C notification is assessment only and stop prevents further callbacks", () => {
  vi.useFakeTimers();
  let wall = 1000,
    mono = 0n;
  const notify = vi.fn();
  const timer = new HistoryRecheck(
    { wallMs: () => wall, monotonicNs: () => mono },
    () => ({ wallAtMs: 1010, waitAtNs: 20000000n }),
    notify,
    100,
  );
  timer.start();
  wall += 10;
  mono += 10000000n;
  vi.advanceTimersByTime(10);
  expect(notify).toHaveBeenCalledTimes(1);
  wall += 10;
  mono += 10000000n;
  vi.advanceTimersByTime(10);
  expect(notify).toHaveBeenCalledTimes(2);
  wall += 100;
  mono += 100000000n;
  vi.advanceTimersByTime(100);
  expect(notify).toHaveBeenCalledTimes(3);
  timer.stop();
  vi.advanceTimersByTime(10000);
  expect(notify).toHaveBeenCalledTimes(3);
});
test("B43-17 missing notification/throw keeps configured C opportunity, never invents a default", () => {
  vi.useFakeTimers();
  expect(
    () =>
      new HistoryRecheck(
        { wallMs: () => 0, monotonicNs: () => 0n },
        () => ({}),
        () => {},
        0,
      ),
  ).toThrow();
  const notify = vi.fn(() => {
    throw Error("not delivered");
  });
  const timer = new HistoryRecheck(
    { wallMs: () => 0, monotonicNs: () => 0n },
    () => ({}),
    notify,
    37,
  );
  timer.start();
  vi.advanceTimersByTime(111);
  expect(notify).toHaveBeenCalledTimes(3);
  timer.stop();
});

test.each([false, true])(
  "B43-03 frozen Drain resolves actual Tx-Q unknown (%s committed) without re-reserving",
  (after) => {
    const f = active(),
      q = f.gate.beginAttempt(provider)!;
    const exec = f.db.exec.bind(f.db),
      prepare = f.db.prepare.bind(f.db);
    let failed = false,
      failRead = true,
      writing = false;
    vi.spyOn(f.db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN IMMEDIATE") writing = true;
      if (sql === "COMMIT" && writing && !failed) {
        failed = true;
        if (after) exec(sql);
        throw Object.assign(Error("private"), { code: "SQLITE_BUSY" });
      }
      return exec(sql);
    });
    vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
      if (
        failed &&
        failRead &&
        sql.startsWith("SELECT provider_key,history_status")
      )
        throw Object.assign(Error("private"), { code: "SQLITE_BUSY" });
      return prepare(sql);
    }) as typeof f.db.prepare);
    // The first COMMIT must be the quota write, not a Gate refresh read.
    const first = f.runtime.reserve({
      providerKey: provider,
      attempt: q.quotaAttempt,
      trust: () => f.gate.quotaTrust(provider),
    });
    expect(first.reservation.outcome).toBe("unknown");
    expect(first.registered).toBe(false);
    const calls = vi.mocked(f.db.exec).mock.calls.length;
    expect(
      f.repo.reserve({
        providerKey: provider,
        attempt: q.quotaAttempt,
        trust: () => f.gate.quotaTrust(provider),
      }).outcome,
    ).toBe("unknown");
    expect(vi.mocked(f.db.exec).mock.calls.length).toBe(calls);
    f.setOs(false);
    f.clock.observe();
    expect(f.recovery.drainAndClassify()).toBe(false);
    expect(f.recovery.waitEvidence()).toEqual([]);
    failRead = false;
    const insert = vi.spyOn(f.repo, "reserve");
    expect(f.recovery.drainAndClassify()).toBe(true);
    expect(insert).not.toHaveBeenCalled();
    expect(f.rows()).toHaveLength(after ? 1 : 0);
    expect(f.runtime.facts()).toEqual([]);
    expect(f.gate.beginAttempt(provider)).toBeNull();
  },
);
test("B43-06 known Range rollback leaves consumption and admits no Wait/authority", () => {
  const f = active(),
    r = f.reserve();
  f.gate.endAttempt(r.attempt);
  f.recovery.suspend();
  const prepare = f.db.prepare.bind(f.db);
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.startsWith("INSERT INTO history_uncertain_ranges"))
      throw Object.assign(Error("private"), { code: "SQLITE_BUSY" });
    return prepare(sql);
  }) as typeof f.db.prepare);
  expect(f.recovery.drainAndClassify()).toBe(false);
  expect(f.db.inTransaction).toBe(false);
  expect(f.db.prepare("SELECT * FROM history_uncertain_ranges").all()).toEqual(
    [],
  );
  expect(f.rows()).toHaveLength(1);
  expect(f.recovery.waitEvidence()).toEqual([]);
});
test("B43-04/09 repeated Clock failures append immutable separate ranges and independent Waits", () => {
  const f = uncertain(),
    first = f.recovery.waitEvidence();
  f.setOs(true);
  f.stabilize();
  expect(f.recovery.recover()).toBe(true);
  const r = f.reserve();
  expect(r.registered).toBe(true);
  f.gate.endAttempt(r.attempt);
  f.setOs(false);
  f.clock.observe();
  expect(f.recovery.drainAndClassify()).toBe(true);
  expect(
    f.db
      .prepare(
        "SELECT range_id,start_sequence,end_sequence FROM history_uncertain_ranges ORDER BY range_id",
      )
      .all(),
  ).toEqual([
    { range_id: 1, start_sequence: 1, end_sequence: 1 },
    { range_id: 2, start_sequence: 2, end_sequence: 2 },
  ]);
  const latest = f.recovery
    .waitEvidence()
    .map(inspectWaitEvidence)
    .filter((v) => v !== null);
  expect(
    latest.filter((v) => v.rangeId === 2).every((v) => v.elapsedNs === 0n),
  ).toBe(true);
  expect(
    first
      .map(inspectWaitEvidence)
      .filter((v) => v?.rangeId === 1)
      .every((v) => v!.elapsedNs > 0n),
  ).toBe(true);
});
function secondFailure() {
  const f = uncertain();
  f.setOs(true);
  f.stabilize();
  expect(f.recovery.recover()).toBe(true);
  const stale = f.reserve();
  expect(stale.registered).toBe(true);
  f.gate.endAttempt(stale.attempt);
  f.setOs(false);
  f.clock.observe();
  expect(f.runtime.isFrozen()).toBe(true);
  expect(f.gate.beginAttempt(provider)).toBeNull();
  return { ...f, stale };
}
const rangeRows = (f: ReturnType<typeof fixture>) =>
  f.db
    .prepare(
      "SELECT range_id,start_sequence,end_sequence FROM history_uncertain_ranges ORDER BY range_id",
    )
    .all();
test("B43-04/05/09 second in-process Clock failure waits per Range and revokes the interval's Trial", () => {
  const f = secondFailure();
  f.setOs(true);
  f.stabilize();
  // Range 1 has completed its 1m Wait; Range 2 starts its own Wait only now.
  expect(f.recovery.drainAndClassify()).toBe(true);
  expect(rangeRows(f)).toEqual([
    { range_id: 1, start_sequence: 1, end_sequence: 1 },
    { range_id: 2, start_sequence: 2, end_sequence: 2 },
  ]);
  expect(f.recovery.recover()).toBe(false);
  for (let i = 0; i < 11; i++) f.advance(5000);
  f.advance(4999);
  expect(f.recovery.recover()).toBe(false);
  expect(f.gate.beginAttempt(provider)).toBeNull();
  f.advance(1);
  expect(f.recovery.recover()).toBe(true);
  expect(
    inspectAuthenticatedHistory(f.recovery.source, f.repo)?.evaluation,
  ).toBe("CONSERVATIVE");
  expect(f.runtime.facts()).toEqual([]);
  expect(f.runtime.register(f.stale.reservation, f.stale.quotaAttempt)).toBe(
    false,
  );
  expect(f.gate.start(f.stale.attempt, f.stale.reservation).kind).toBe(
    "blocked",
  );
  const next = f.reserve();
  expect(next.registered).toBe(true);
  expect(f.runtime.facts().map((v) => v.sequence)).toEqual([3]);
  expect(f.gate.start(next.attempt, next.reservation).kind).toBe("started");
  f.finish();
  expect(f.calls()).toBe(1);
  expect(rangeRows(f)).toHaveLength(2);
});
test("B43-06 second-failure Range COMMIT unknown keeps earlier Range and stays closed", () => {
  const f = secondFailure();
  const exec = f.db.exec.bind(f.db),
    prepare = f.db.prepare.bind(f.db);
  let rangeWrite = false;
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.startsWith("INSERT INTO history_uncertain_ranges"))
      rangeWrite = true;
    return prepare(sql);
  }) as typeof f.db.prepare);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const out = exec(sql);
    if (sql === "COMMIT" && rangeWrite)
      throw Object.assign(Error("private"), { code: "SQLITE_BUSY" });
    return out;
  });
  expect(f.recovery.drainAndClassify()).toBe(false);
  vi.mocked(f.db.exec).mockRestore();
  vi.mocked(f.db.prepare).mockRestore();
  expect(connectionCoordination(f.db).blocked).toBeDefined();
  expect(f.recovery.waitEvidence()).toEqual([]);
  expect(rangeRows(f)[0]).toEqual({
    range_id: 1,
    start_sequence: 1,
    end_sequence: 1,
  });
  f.advance(90000000, false);
  f.setOs(true);
  f.stabilize();
  expect(f.recovery.recover()).toBe(false);
  expect(f.gate.beginAttempt(provider)).toBeNull();
  expect(f.rows()).toHaveLength(2);
  expect(f.calls()).toBe(0);
});
test("B43-15/17 Quota hold is reassessed by B/C notifications; lost or untrusted rechecks keep stops", () => {
  vi.useFakeTimers();
  const f = fixture(1),
    management = f.gate.stopControl(provider);
  management.stop();
  // The old row fills the 1s Window until its 1m Wait completes.
  expect(f.recovery.recover()).toBe(false);
  const outcomes: boolean[] = [];
  let lost = true;
  const timer = new HistoryRecheck(
    f.time,
    () => {
      const hint = f.recovery.recheckHint();
      return hint.waitAtNs === undefined ? {} : { waitAtNs: hint.waitAtNs };
    },
    () => {
      if (lost) {
        lost = false;
        throw Error("notification lost");
      }
      outcomes.push(f.recovery.recover());
    },
    120000,
  );
  timer.start();
  for (let i = 0; i < 12; i++) f.advance(5000);
  vi.advanceTimersByTime(60000); // B deadline: notification is lost
  expect(outcomes).toEqual([]);
  f.setOs(false);
  for (let i = 0; i < 24; i++) f.advance(5000);
  vi.advanceTimersByTime(120000); // C: Quota room, but Clock untrusted
  expect(outcomes).toEqual([false]);
  expect(f.runtime.isFrozen()).toBe(true);
  f.setOs(true);
  f.stabilize();
  for (let i = 0; i < 10; i++) f.advance(5000);
  vi.advanceTimersByTime(120000); // C again: assessment succeeds
  expect(outcomes).toEqual([false, true]);
  timer.stop();
  expect(f.gate.beginAttempt(provider)).toBeNull();
  expect(f.calls()).toBe(0);
  expect(f.history.state()).toBe("UNVERIFIED");
  management.release();
  const r = f.reserve();
  expect(r.registered).toBe(true);
  expect(f.gate.start(r.attempt, r.reservation).kind).toBe("started");
  f.finish();
});
test("B43-08 bound Source cannot be created from structural copies or another Clock", () => {
  const f = active();
  expect(
    () =>
      new HistoryRecovery(
        f.db,
        f.repo,
        { ...f.runtime } as RuntimeHistory,
        f.gate,
        f.clock,
      ),
  ).toThrow();
  expect(
    () =>
      new HistoryRecovery(
        f.db,
        f.repo,
        f.runtime,
        { ...f.gate } as ProviderSendGate,
        f.clock,
      ),
  ).toThrow();
  const other = new ClockTrustMonitor(f.time, () => null);
  expect(
    () => new HistoryRecovery(f.db, f.repo, f.runtime, f.gate, other),
  ).toThrow();
});
test("B43-09 a committed Range proof stops authenticating if its actual DB boundary changes", () => {
  const f = uncertain(),
    proofs = f.recovery.waitEvidence();
  f.db.exec("DELETE FROM history_uncertain_ranges");
  expect(proofs.filter((p) => inspectWaitEvidence(p)?.rangeId === 1)).toEqual(
    [],
  );
  f.setOs(true);
  f.stabilize();
  expect(f.recovery.recover()).toBe(false);
  expect(f.gate.beginAttempt(provider)).toBeNull();
});
test("B43-12 F-01 commit exception never issues Runtime Provisioning evidence", () => {
  const f = fixture(0, false);
  const exec = f.db.exec.bind(f.db);
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "COMMIT")
      throw Object.assign(Error("private"), { code: "SQLITE_BUSY" });
    return result;
  });
  expect(
    f.repo.provisionProvider(provider, {
      clockTrusted: true,
      pastUseOutsideQuotaPeriodsConfirmed: true,
      safetyMarginConfirmed: true,
      exclusiveKeyUseConfirmed: true,
    }).outcome,
  ).toBe("unknown");
  expect(f.recovery.confirmRuntimeProvisioning()).toBeNull();
  expect(f.runtime.effectiveCutoff()).toBeNull();
  expect(f.recovery.recover()).toBe(false);
});
test("B43-13 saved without registration blocks Send Gate even with otherwise valid reservation evidence", () => {
  const f = active(),
    q = f.gate.beginAttempt(provider)!;
  const saved = f.repo.reserve({
    providerKey: provider,
    attempt: q.quotaAttempt,
    trust: () => f.gate.quotaTrust(provider),
  });
  expect(saved.outcome).toBe("saved");
  expect(f.runtime.facts()).toEqual([]);
  expect(f.gate.start(q.attempt, saved).kind).toBe("blocked");
  expect(f.calls()).toBe(0);
  expect(f.rows()).toHaveLength(1);
});
test("B43-13 changed Valid row after reservation is rejected before HTTP", () => {
  const f = active(),
    r = f.reserve();
  f.db.exec("UPDATE provider_quota_consumptions SET reserved_at_ms=1");
  expect(f.gate.start(r.attempt, r.reservation).kind).toBe("blocked");
  expect(f.calls()).toBe(0);
  expect(f.rows()).toHaveLength(1);
});
test("B43-14/15 independent global stop prevents even direct Tx-Q via a valid authenticated source", () => {
  const f = active(),
    q = f.repo.beginAttempt(provider),
    stop = f.gate.stopControl("global");
  stop.stop();
  const r = f.runtime.reserve({
    providerKey: provider,
    attempt: q,
    trust: () => f.gate.quotaTrust(provider),
  });
  expect(r.reservation.outcome).toBe("quota_blocked");
  expect(f.rows()).toEqual([]);
  f.repo.endAttempt(q);
});
test("B43-17 Scheduler notification path cannot resume a stopped Gate", () => {
  vi.useFakeTimers();
  const f = active();
  f.recovery.suspend();
  const notify = vi.fn(() => {
    expect(f.gate.beginAttempt(provider)).toBeNull();
  });
  const timer = new HistoryRecheck(
    f.time,
    () => f.recovery.recheckHint(),
    notify,
    17,
  );
  timer.start();
  vi.advanceTimersByTime(51);
  expect(notify).toHaveBeenCalledTimes(3);
  expect(f.calls()).toBe(0);
  timer.stop();
});

test("B43-13/15 invalidation during the final History read prevents HTTP", () => {
  const f = active(),
    r = f.reserve();
  const prepare = f.db.prepare.bind(f.db);
  let reads = 0;
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (sql.startsWith("SELECT range_id,start_sequence") && ++reads === 2) {
      f.setOs(false);
      f.clock.observe();
    }
    return prepare(sql);
  }) as typeof f.db.prepare);
  expect(f.gate.start(r.attempt, r.reservation).kind).toBe("blocked");
  expect(f.calls()).toBe(0);
  expect(f.runtime.isFrozen()).toBe(true);
  expect(f.rows()).toHaveLength(1);
});
test("B43-01/13 Clock invalidation during Tx-Q History evaluation rolls back before reservation", () => {
  const f = active(),
    q = f.gate.beginAttempt(provider)!;
  const prepare = f.db.prepare.bind(f.db);
  const exec = f.db.exec.bind(f.db);
  let writing = false;
  vi.spyOn(f.db, "exec").mockImplementation((sql) => {
    const result = exec(sql);
    if (sql === "BEGIN IMMEDIATE") writing = true;
    return result;
  });
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (writing && sql.startsWith("SELECT range_id,start_sequence")) {
      f.setOs(false);
      f.clock.observe();
    }
    return prepare(sql);
  }) as typeof f.db.prepare);
  const r = f.runtime.reserve({
    providerKey: provider,
    attempt: q.quotaAttempt,
    trust: () => f.gate.quotaTrust(provider),
  });
  expect(r.reservation.outcome).toBe("quota_blocked");
  expect(f.rows()).toEqual([]);
  expect(f.calls()).toBe(0);
});
test("B43-16 CONSERVATIVE resume candidate is not History CLEAN eligibility", () => {
  const f = fixture(1);
  expect(f.recovery.historyCleanEligible()).toBe(false);
  f.recovery.drainAndClassify();
  f.advance(60000, false);
  f.stabilize();
  expect(f.recovery.recover()).toBe(true);
  expect(f.recovery.historyCleanEligible()).toBe(false);
  expect(f.db.prepare("SELECT state FROM backend_lifecycle").get()).toEqual({
    state: "RUNNING",
  });
});
test("B43-17 no hard-coded 5m and long Timer conversion stays bounded", () => {
  vi.useFakeTimers();
  const timerSpy = vi.spyOn(globalThis, "setTimeout");
  const notify = vi.fn();
  const timer = new HistoryRecheck(
    { wallMs: () => 0, monotonicNs: () => 0n },
    () => ({ waitAtNs: 10n ** 30n }),
    notify,
    2147483647,
  );
  timer.start();
  expect(timerSpy.mock.calls.at(-1)![1]).toBe(2147483647);
  expect(notify).not.toHaveBeenCalled();
  timer.stop();
});

test("B43-13 classified gap prohibits another Tx-Q, not merely HTTP", () => {
  const f = active(),
    q = f.repo.beginAttempt(provider);
  expect(
    f.repo.reserve({
      providerKey: provider,
      attempt: q,
      trust: () => f.gate.quotaTrust(provider),
    }).outcome,
  ).toBe("saved");
  f.repo.endAttempt(q);
  const next = f.repo.beginAttempt(provider);
  const exec = vi.spyOn(f.db, "exec");
  expect(
    f.runtime.reserve({
      providerKey: provider,
      attempt: next,
      trust: () => f.gate.quotaTrust(provider),
    }).reservation.outcome,
  ).toBe("quota_blocked");
  expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(
    false,
  );
  expect(f.rows()).toHaveLength(1);
  f.repo.endAttempt(next);
});

test("B43-08 transient History read BUSY fails closed without permanently poisoning a healthy Connection", () => {
  const f = active();
  const prepare = f.db.prepare.bind(f.db);
  let fail = true;
  vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
    if (fail && sql.startsWith("SELECT range_id,start_sequence"))
      throw Object.assign(Error("private"), { code: "SQLITE_BUSY" });
    return prepare(sql);
  }) as typeof f.db.prepare);
  expect(inspectAuthenticatedHistory(f.recovery.source, f.repo)).toBeNull();
  expect(connectionCoordination(f.db).blocked).toBeUndefined();
  expect(f.db.inTransaction).toBe(false);
  fail = false;
  expect(inspectAuthenticatedHistory(f.recovery.source, f.repo)).not.toBeNull();
});
test("B43-17 stop from a notification synchronously prohibits Timer re-arming", () => {
  vi.useFakeTimers();
  const notify = vi.fn(() => timer.stop());
  const timer: HistoryRecheck = new HistoryRecheck(
    { wallMs: () => 0, monotonicNs: () => 0n },
    () => ({}),
    notify,
    19,
  );
  timer.start();
  vi.advanceTimersByTime(190);
  expect(notify).toHaveBeenCalledTimes(1);
});

test("B43-15 SUSPENDED metadata remains independent of authenticated History and Clock recovery", () => {
  const f = active();
  f.db.exec("UPDATE provider_quota_metadata SET history_status='SUSPENDED'");
  expect(f.gate.beginAttempt(provider)).toBeNull();
  expect(inspectAuthenticatedHistory(f.recovery.source, f.repo)).toBeNull();
  f.recovery.suspend();
  f.stabilize();
  expect(f.recovery.recover()).toBe(false);
  expect(
    f.db.prepare("SELECT history_status FROM provider_quota_metadata").get(),
  ).toEqual({ history_status: "SUSPENDED" });
});

test("B43-17 trusted Timestamp supplies A without inventing an uncertain wall deadline", () => {
  const f = active(),
    r = f.reserve();
  f.gate.endAttempt(r.attempt);
  const result = f.repo.inspect(
    provider,
    {
      clockTrusted: false,
      historyTimestampsTrusted: false,
      historyComplete: false,
    },
    f.wall(),
  );
  expect(result).toEqual({
    allowed: false,
    reason: "quota_exhausted",
    recheckAtMs: f.wall() + 3001,
  });
});

test("B43-08 incomplete Sequence data issues no Drain authority, not even for discarding Valid", () => {
  const f = active(),
    r = f.reserve();
  f.gate.endAttempt(r.attempt);
  f.recovery.suspend();
  f.db.exec("UPDATE provider_quota_metadata SET last_sequence=2");
  const discard = vi.spyOn(f.runtime, "discardAffected");
  expect(f.recovery.drainAndClassify()).toBe(false);
  expect(discard).not.toHaveBeenCalled();
  expect(f.recovery.waitEvidence()).toEqual([]);
  expect(f.db.prepare("SELECT * FROM history_uncertain_ranges").all()).toEqual(
    [],
  );
});
