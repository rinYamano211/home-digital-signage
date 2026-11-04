import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import {
  BackendStore,
  configureDatabase,
  type StartupStoreAccess,
} from "../../src/backend/storage/store.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import { quotaRepositoryOwnsConnection } from "../../src/backend/storage/quota-repository.js";
import { createProviderSendGate } from "../../src/backend/send/provider-send-gate.js";
import { TOMORROW_IO } from "../../src/backend/quota/quota-guard.js";
import type { ExclusiveLock } from "../../src/backend/storage/lock.js";
import { readOsBootId } from "../../src/backend/time/boot-id.js";
import { ClockTrustMonitor } from "../../src/backend/send/internal/trust.js";
import {
  RuntimeHistory,
  runtimeHistoryMatches,
} from "../../src/backend/quota/internal/runtime-history.js";
import type { DrainBoundaryEvidence } from "../../src/backend/quota/internal/history-boundaries.js";
vi.mock("../../src/backend/time/boot-id.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/time/boot-id.js")>()),
  readOsBootId: vi.fn(),
}));
vi.mock("../../src/backend/storage/paths.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/storage/paths.js")>()),
  validateDatabaseFiles: vi.fn(),
}));
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const untrusted = Object.freeze({
  clockTrusted: false,
  historyTimestampsTrusted: false,
  historyComplete: false,
});
const confirmed = Object.freeze({
  clockTrusted: true,
  pastUseOutsideQuotaPeriodsConfirmed: true,
  safetyMarginConfirmed: true,
  exclusiveKeyUseConfirmed: true,
});
const dirs: string[] = [];
const handles: StartupStoreAccess[] = [];
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) h.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
/** Real v3 file reopened through the restricted facade. The private Connection
 * is captured only so tests can create Connection-level conditions.
 */
function open(provisioned = false) {
  const dir = mkdtempSync(join(tmpdir(), "signage-runtime-store-"));
  dirs.push(dir);
  const seed = new Database(join(dir, "signage.db"));
  initializeSchema(seed);
  configureDatabase(seed, 3);
  seed.exec(LIFECYCLE_DDL);
  seed
    .prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,1)")
    .run(boot);
  if (provisioned)
    seed
      .prepare("INSERT INTO provider_quota_metadata VALUES (?,'ACTIVE',0,0)")
      .run(TOMORROW_IO);
  seed.pragma("user_version=3");
  seed.close();
  const lock = {
    directory: dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock;
  const spy = vi.spyOn(Database.prototype, "pragma");
  const h = BackendStore.openV3ForStartup(lock);
  const db = spy.mock.contexts[0] as Database.Database;
  spy.mockRestore();
  handles.push(h);
  return { h, db };
}
const commit = (h: StartupStoreAccess) =>
  expect(h.startup.execute({ bootId: boot })).toMatchObject({
    outcome: "committed",
  });
test("R1-01/02 Runtime opens only after this facade's own committed Startup", () => {
  const { h } = open();
  expect(BackendStore.activateRuntime(h)).toBeNull();
  // The seeded Lifecycle row is RUNNING already; that alone is not evidence.
  expect(h.lifecycle.read()).toMatchObject({ marker: { state: "RUNNING" } });
  expect(BackendStore.activateRuntime(h)).toBeNull();
  commit(h);
  expect(BackendStore.activateRuntime(h)?.runtimeActive).toBe(true);
  expect(BackendStore.activateRuntime({ ...h })).toBeNull();
  expect(
    BackendStore.activateRuntime({} as unknown as StartupStoreAccess),
  ).toBeNull();
});
test("R1-03 rejected Startup never opens Runtime", () => {
  const { h } = open();
  expect(
    h.startup.execute({ bootId: "11111111-2222-3333-4444-555555555555" }),
  ).toMatchObject({ outcome: "rejected" });
  expect(BackendStore.activateRuntime(h)).toBeNull();
  // A retry on the same Connection is refused, so Runtime stays closed.
  expect(h.startup.execute({ bootId: boot })).toMatchObject({
    outcome: "rejected",
    reason: "startup_already_attempted",
  });
  expect(BackendStore.activateRuntime(h)).toBeNull();
});
test("R1-04 unknown Startup Commit never opens Runtime, even with committed rows", () => {
  const { h, db } = open();
  const exec = db.exec.bind(db);
  vi.spyOn(db, "exec").mockImplementation((sql) => {
    const out = exec(sql);
    if (sql === "COMMIT")
      throw Object.assign(Error("private"), { code: "SQLITE_BUSY" });
    return out;
  });
  expect(h.startup.execute({ bootId: boot })).toMatchObject({
    outcome: "unknown",
  });
  vi.mocked(db.exec).mockRestore();
  // The rows did commit (Generation 2), but no Commit evidence was recorded.
  expect(h.lifecycle.read()).toMatchObject({ marker: { generation: 2 } });
  expect(BackendStore.activateRuntime(h)).toBeNull();
});
test.each(["blocked", "unresolved"])(
  "R1-05 %s Connection never opens Runtime",
  (kind) => {
    const { h, db } = open();
    commit(h);
    const c = connectionCoordination(db);
    if (kind === "blocked")
      c.blocked = { scope: "database", layer: "L4", reason: "synthetic" };
    else c.connectionUnresolved = true;
    expect(BackendStore.activateRuntime(h)).toBeNull();
  },
);
test("R1-06 an active Transaction or busy owner prevents activation", () => {
  const { h, db } = open();
  commit(h);
  db.exec("BEGIN");
  expect(BackendStore.activateRuntime(h)).toBeNull();
  db.exec("ROLLBACK");
  const c = connectionCoordination(db);
  c.busy = true;
  expect(BackendStore.activateRuntime(h)).toBeNull();
  c.busy = false;
  expect(BackendStore.activateRuntime(h)).not.toBeNull();
});
test("R1-07/08 same Connection and one Repository across repeated activation", () => {
  const { h, db } = open();
  commit(h);
  const first = BackendStore.activateRuntime(h)!;
  const second = BackendStore.activateRuntime(h)!;
  expect(second).toBe(first);
  expect(second.quota).toBe(first.quota);
  expect(quotaRepositoryOwnsConnection(first.quota, db)).toBe(true);
  expect(db.open).toBe(true);
  // A single Attempt slot proves no second Repository shares this Connection.
  const attempt = first.quota.beginAttempt(TOMORROW_IO);
  expect(() => second.quota.beginAttempt(TOMORROW_IO)).toThrow(
    "Quota attempt unavailable",
  );
  first.quota.endAttempt(attempt);
});
test("R1-09 Close prevents activation and fails the previously activated Runtime closed", () => {
  const { h, db } = open();
  commit(h);
  const runtime = BackendStore.activateRuntime(h)!;
  h.close();
  expect(db.open).toBe(false);
  expect(BackendStore.activateRuntime(h)).toBeNull();
  expect(runtime.quota.inspect(TOMORROW_IO, untrusted).allowed).toBe(false);
  expect(
    runtime.quota.provisionProvider(TOMORROW_IO, confirmed).outcome,
  ).not.toBe("initialized");
  expect(() => h.close()).not.toThrow();
});
test("R1-10 Runtime exposes only Quota; the Startup facade keeps its restricted shape", () => {
  const { h } = open();
  commit(h);
  const runtime = BackendStore.activateRuntime(h)!;
  expect(Object.keys(runtime).sort()).toEqual(["quota", "runtimeActive"]);
  expect(Object.isFrozen(runtime)).toBe(true);
  for (const key of ["db", "startup", "lifecycle", "close", "exec", "send"])
    expect(runtime).not.toHaveProperty(key);
  expect(Object.keys(h).sort()).toEqual([
    "close",
    "lifecycle",
    "startup",
    "startupComplete",
  ]);
  expect(h.startupComplete).toBe(false);
  expect(h).not.toHaveProperty("quota");
  expect(h.startup.execute({ bootId: boot })).toMatchObject({
    reason: "startup_already_attempted",
  });
});
test("R1-11 v3 QuotaRepository validates the v3 Schema and keeps its quota contract", () => {
  const { h, db } = open();
  commit(h);
  const quota = BackendStore.activateRuntime(h)!.quota;
  expect(quota.inspect(TOMORROW_IO, untrusted)).toEqual({
    allowed: false,
    reason: "clock_untrusted",
  });
  expect(quota.provisionProvider(TOMORROW_IO, confirmed)).toEqual({
    outcome: "initialized",
  });
  expect(
    db.prepare("SELECT history_status FROM provider_quota_metadata").get(),
  ).toEqual({ history_status: "ACTIVE" });
  const attempt = quota.beginAttempt(TOMORROW_IO);
  expect(
    quota.reserve({
      providerKey: TOMORROW_IO,
      attempt,
      trust: () => untrusted,
    }).outcome,
  ).toBe("quota_blocked");
  quota.endAttempt(attempt);
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions").get(),
  ).toEqual({ n: 0 });
});
test("R1-12 Runtime activation grants no Trust or send authority", () => {
  const { h } = open();
  commit(h);
  const quota = BackendStore.activateRuntime(h)!.quota;
  const gate = createProviderSendGate(quota);
  expect(gate.reservationStatus(TOMORROW_IO).allowed).toBe(false);
  expect(gate.quotaTrust(TOMORROW_IO)).toEqual(untrusted);
  expect(gate.beginAttempt(TOMORROW_IO)).toBeNull();
  gate.dispose();
});
const clockOf = () =>
  new ClockTrustMonitor(
    { wallMs: () => 200_000_000, monotonicNs: () => 1_000_000_000n },
    () => null,
  );
test.each(["before", "rejected", "unknown"])(
  "R2A-01 Startup state %s creates no Runtime History",
  (kind) => {
    const { h, db } = open();
    const clock = clockOf();
    if (kind === "rejected")
      h.startup.execute({ bootId: "11111111-2222-3333-4444-555555555555" });
    if (kind === "unknown") {
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        const out = exec(sql);
        if (sql === "COMMIT")
          throw Object.assign(Error("private"), { code: "SQLITE_BUSY" });
        return out;
      });
      h.startup.execute({ bootId: boot });
      vi.mocked(db.exec).mockRestore();
    }
    expect(BackendStore.createRuntimeHistory(h, clock)).toBeNull();
    expect(BackendStore.createRuntimeHistory({ ...h }, clock)).toBeNull();
    // A refused precondition does not consume the single owner slot.
    if (kind === "before") {
      commit(h);
      expect(BackendStore.createRuntimeHistory(h, clock)).not.toBeNull();
    } else
      expect(h.startup.execute({ bootId: boot })).toMatchObject({
        reason: "startup_already_attempted",
      });
  },
);
test("R2A-02/03 same Connection and QuotaRepository; repeated calls return one bundle", () => {
  const { h, db } = open(true);
  commit(h);
  const clock = clockOf();
  const quota = BackendStore.activateRuntime(h)!.quota;
  const access = BackendStore.createRuntimeHistory(h, clock)!;
  expect(runtimeHistoryMatches(access.history, db, quota, clock)).toBe(true);
  expect(access.history.scope()).toMatchObject({ generation: 2 });
  // Ranges reads through the bundled History's provisioned Startup cutoff.
  expect(access.history.effectiveCutoff()).toBe(0);
  expect(access.ranges.read()).toEqual({ outcome: "read", ranges: [] });
  expect(BackendStore.createRuntimeHistory(h, clock)).toBe(access);
  expect(Object.keys(access).sort()).toEqual(["history", "ranges"]);
  expect(Object.isFrozen(access)).toBe(true);
  expect(Object.isFrozen(access.history)).toBe(false);
  expect(BackendStore.activateRuntime(h)!.quota).toBe(quota);
});
test("R2A-04 another or forged Clock is refused; the single owner stays", () => {
  const { h, db } = open();
  commit(h);
  const clock = clockOf();
  const access = BackendStore.createRuntimeHistory(h, clock)!;
  expect(BackendStore.createRuntimeHistory(h, clockOf())).toBeNull();
  expect(
    BackendStore.createRuntimeHistory(h, {
      ...clock,
    } as unknown as ClockTrustMonitor),
  ).toBeNull();
  expect(BackendStore.createRuntimeHistory(h, clock)).toBe(access);
  const quota = BackendStore.activateRuntime(h)!.quota;
  expect(() => new RuntimeHistory(db, quota, clock)).toThrow(
    "Runtime History already owned",
  );
});
test("R2A-04 a failed creation is not retried and returns no partial bundle", () => {
  const { h, db } = open();
  commit(h);
  const clock = clockOf();
  // Another owner already took the Connection: the Store's creation throws.
  new RuntimeHistory(db, BackendStore.activateRuntime(h)!.quota, clock);
  expect(BackendStore.createRuntimeHistory(h, clock)).toBeNull();
  expect(BackendStore.createRuntimeHistory(h, clock)).toBeNull();
  expect(BackendStore.activateRuntime(h)).not.toBeNull();
});
test.each(["busy", "blocked", "unresolved", "transaction", "closed"])(
  "R2A-05 %s Connection refuses creation and later reuse",
  (kind) => {
    const { h, db } = open();
    commit(h);
    const clock = clockOf();
    const access = BackendStore.createRuntimeHistory(h, clock)!;
    const c = connectionCoordination(db);
    if (kind === "busy") c.busy = true;
    else if (kind === "blocked")
      c.blocked = { scope: "database", layer: "L4", reason: "synthetic" };
    else if (kind === "unresolved") c.connectionUnresolved = true;
    else if (kind === "transaction") db.exec("BEGIN");
    else h.close();
    expect(BackendStore.createRuntimeHistory(h, clock)).toBeNull();
    if (kind === "busy") c.busy = false;
    if (kind === "transaction") db.exec("ROLLBACK");
    if (kind === "busy" || kind === "transaction")
      expect(BackendStore.createRuntimeHistory(h, clock)).toBe(access);
    if (kind === "closed") expect(access.history.scope()).toBeNull();
  },
);
test("R2A-05 a fresh Connection condition also refuses the first creation", () => {
  const { h, db } = open();
  commit(h);
  const clock = clockOf();
  db.exec("BEGIN");
  expect(BackendStore.createRuntimeHistory(h, clock)).toBeNull();
  db.exec("ROLLBACK");
  expect(BackendStore.createRuntimeHistory(h, clock)).not.toBeNull();
});
test("R2A-06 Runtime History creation grants no Trust, reservation, Range or send authority", () => {
  const { h, db } = open();
  commit(h);
  const clock = clockOf();
  const quota = BackendStore.activateRuntime(h)!.quota;
  expect(quota.provisionProvider(TOMORROW_IO, confirmed).outcome).toBe(
    "initialized",
  );
  const { history, ranges } = BackendStore.createRuntimeHistory(h, clock)!;
  clock.observe();
  expect(clock.state()).not.toBe("TRUSTED");
  const attempt = quota.beginAttempt(TOMORROW_IO);
  expect(
    history.reserve({
      providerKey: TOMORROW_IO,
      attempt,
      trust: () => untrusted,
    }),
  ).toEqual({
    reservation: {
      outcome: "quota_blocked",
      reason: "runtime_history_unverified",
    },
    registered: false,
  });
  quota.endAttempt(attempt);
  expect(history.facts()).toEqual([]);
  expect(
    ranges.insert(
      { rangeId: 1, startSequence: 1, endSequence: 1 },
      {} as DrainBoundaryEvidence,
    ),
  ).toEqual({ outcome: "rejected", reason: "drain_unverified" });
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions").get(),
  ).toEqual({ n: 0 });
  const gate = createProviderSendGate(quota);
  expect(gate.reservationStatus(TOMORROW_IO).allowed).toBe(false);
  expect(gate.beginAttempt(TOMORROW_IO)).toBeNull();
  gate.dispose();
});
