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
import { createRuntimeSend } from "../../src/backend/send/provider-send-gate.js";
import { ProviderSendGate } from "../../src/backend/send/internal/provider-send-gate.js";
import {
  ClockTrustMonitor,
  HistoryTrustMonitor,
} from "../../src/backend/send/internal/trust.js";
import { QuotaRepository } from "../../src/backend/storage/quota-repository.js";
import { TOMORROW_IO } from "../../src/backend/quota/quota-guard.js";
import type { ExclusiveLock } from "../../src/backend/storage/lock.js";
import { readOsBootId } from "../../src/backend/time/boot-id.js";
const os = vi.hoisted(() => ({ output: "yes\n" as string | Error }));
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const done = args.at(-1) as (e: Error | null, out: string) => void;
    if (os.output instanceof Error) done(os.output, "");
    else done(null, os.output);
  },
}));
vi.mock("../../src/backend/time/boot-id.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/time/boot-id.js")>()),
  readOsBootId: vi.fn(),
}));
vi.mock("../../src/backend/storage/paths.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/storage/paths.js")>()),
  validateDatabaseFiles: vi.fn(),
}));
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];
const handles: StartupStoreAccess[] = [];
let wall = 0,
  mono = 0n;
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
  os.output = "yes\n";
  wall = 1_800_000_000_000;
  mono = 10_000_000_000n;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => mono);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) h.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
/** Wall and monotonic time move together; Timers fire second by second. */
async function advance(ms: number) {
  for (let i = 0; i < ms / 1000; i++) {
    wall += 1000;
    mono += 1_000_000_000n;
    await vi.advanceTimersByTimeAsync(1000);
  }
}
/** Provisioned real v3 DB with `old` consumptions from a previous Process. */
function committed(old = 0) {
  const dir = mkdtempSync(join(tmpdir(), "signage-runtime-send-"));
  dirs.push(dir);
  const seed = new Database(join(dir, "signage.db"));
  initializeSchema(seed);
  configureDatabase(seed, 3);
  seed.exec(LIFECYCLE_DDL);
  seed
    .prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,1)")
    .run(boot);
  seed
    .prepare("INSERT INTO provider_quota_metadata VALUES (?,'ACTIVE',0,?)")
    .run(TOMORROW_IO, old);
  for (let i = 1; i <= old; i++)
    seed
      .prepare("INSERT INTO provider_quota_consumptions VALUES (?,?,?)")
      .run(TOMORROW_IO, i, wall - 1000 * i);
  seed.pragma("user_version=3");
  seed.close();
  const lock = {
    directory: dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock;
  const h = BackendStore.openV3ForStartup(lock);
  handles.push(h);
  return h;
}
const commit = (h: StartupStoreAccess) =>
  expect(h.startup.execute({ bootId: boot })).toMatchObject({
    outcome: "committed",
  });
const clockOf = () =>
  new ClockTrustMonitor(
    { wallMs: () => wall, monotonicNs: () => mono },
    () => null,
  );
test("R2B HistoryRecovery is created once, after Runtime History with the same Clock and Gate", () => {
  const h = committed();
  const clock = clockOf();
  const quota = () => BackendStore.activateRuntime(h)!.quota;
  const gateFor = (repository: QuotaRepository, c = clock) =>
    new ProviderSendGate(
      new Map([
        [TOMORROW_IO, { repository, history: new HistoryTrustMonitor() }],
      ]),
      c,
      { wallMs: () => wall, monotonicNs: () => mono },
    );
  // Not committed: no Runtime Repository exists yet, so use an unrelated one.
  const unrelated = new QuotaRepository(new Database(":memory:"), 3);
  expect(
    BackendStore.createHistoryRecovery(h, gateFor(unrelated), clock),
  ).toBeNull();
  commit(h);
  const gate = gateFor(quota());
  expect(BackendStore.createHistoryRecovery(h, gate, clock)).toBeNull(); // no Runtime History
  expect(BackendStore.createRuntimeHistory(h, clock)).not.toBeNull();
  expect(BackendStore.createHistoryRecovery(h, gate, clockOf())).toBeNull();
  expect(BackendStore.createHistoryRecovery({ ...h }, gate, clock)).toBeNull();
  const recovery = BackendStore.createHistoryRecovery(h, gate, clock)!;
  expect(recovery).not.toBeNull();
  expect(BackendStore.createHistoryRecovery(h, gate, clock)).toBe(recovery);
  expect(BackendStore.createHistoryRecovery(h, gateFor(quota()), clock)).toBe(
    null,
  );
  // Creation closes the Gate and freezes Runtime History; no Trust is granted.
  expect(gate.beginAttempt(TOMORROW_IO)).toBeNull();
  expect(BackendStore.createRuntimeHistory(h, clock)!.history.isFrozen()).toBe(
    true,
  );
  h.close();
  expect(BackendStore.createHistoryRecovery(h, gate, clock)).toBeNull();
});
test("R2B a failed HistoryRecovery creation is not retried", () => {
  const h = committed();
  commit(h);
  const clock = clockOf();
  expect(BackendStore.createRuntimeHistory(h, clock)).not.toBeNull();
  // A Gate bound to another Repository fails the constructor's identity check.
  const other = new ProviderSendGate(
    new Map([
      [
        TOMORROW_IO,
        {
          repository: new QuotaRepository(new Database(":memory:"), 3),
          history: new HistoryTrustMonitor(),
        },
      ],
    ]),
    clock,
    { wallMs: () => wall, monotonicNs: () => mono },
  );
  expect(BackendStore.createHistoryRecovery(h, other, clock)).toBeNull();
  const gate = new ProviderSendGate(
    new Map([
      [
        TOMORROW_IO,
        {
          repository: BackendStore.activateRuntime(h)!.quota,
          history: new HistoryTrustMonitor(),
        },
      ],
    ]),
    clock,
    { wallMs: () => wall, monotonicNs: () => mono },
  );
  expect(BackendStore.createHistoryRecovery(h, gate, clock)).toBeNull();
});
test("5B no Runtime Send before a committed Startup or for a forged facade", () => {
  const h = committed();
  expect(createRuntimeSend(h)).toBeNull();
  commit(h);
  expect(createRuntimeSend({ ...h })).toBeNull();
});
test("5B fresh history: closed until OS sync, Clock stability and Recovery; still no HTTP adapter", async () => {
  const h = committed();
  commit(h);
  const send = createRuntimeSend(h)!;
  send.startMonitoring();
  expect(send.beginAttempt(TOMORROW_IO)).toBeNull();
  await advance(4 * 60_000); // Clock is TRUSTED after 60s; C has not fired yet
  expect(send.reservationStatus(TOMORROW_IO).allowed).toBe(false);
  await advance(61_000); // C (5 minutes) runs recover()
  expect(send.reservationStatus(TOMORROW_IO).allowed).toBe(true);
  const attempt = send.beginAttempt(TOMORROW_IO)!;
  expect(attempt).not.toBeNull();
  expect(send.quotaTrust(TOMORROW_IO).historyTimestampsTrusted).toBe(false);
  send.endAttempt(attempt.attempt);
  send.stopMonitoring();
  expect(send.beginAttempt(TOMORROW_IO)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  send.stopMonitoring(); // idempotent
});
test("5B restart with old history waits conservatively, then reopens via the production Wait clock", async () => {
  const h = committed(1);
  commit(h);
  const send = createRuntimeSend(h)!;
  send.startMonitoring();
  // First C (5m) drains and starts Waits; the old row fills the 1s window.
  // HistoryRecheck plans before notifying, so the next opportunity is C (10m).
  await advance(10 * 60_000 - 30_000);
  expect(send.reservationStatus(TOMORROW_IO).allowed).toBe(false);
  expect(send.beginAttempt(TOMORROW_IO)).toBeNull();
  await advance(30_000);
  expect(send.reservationStatus(TOMORROW_IO).allowed).toBe(true);
  send.stopMonitoring();
});
test.each([
  ["no", "no\n"],
  ["failing", Error("timedatectl unavailable")],
])("5B %s OS sync keeps sending closed", async (_, output) => {
  os.output = output;
  const h = committed();
  commit(h);
  const send = createRuntimeSend(h)!;
  send.startMonitoring();
  await advance(11 * 60_000);
  expect(send.reservationStatus(TOMORROW_IO).allowed).toBe(false);
  expect(send.beginAttempt(TOMORROW_IO)).toBeNull();
  send.stopMonitoring();
});
