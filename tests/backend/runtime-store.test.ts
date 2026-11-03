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
function open() {
  const dir = mkdtempSync(join(tmpdir(), "signage-runtime-store-"));
  dirs.push(dir);
  const seed = new Database(join(dir, "signage.db"));
  initializeSchema(seed);
  configureDatabase(seed, 3);
  seed.exec(LIFECYCLE_DDL);
  seed
    .prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,1)")
    .run(boot);
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
