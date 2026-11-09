// Issue #93 PR 3 (technology-stack 21.9): offline F-01 Quota Provisioning.
// Real SQLite. Only OS boundaries are mocked, as in coordinator.test.ts (the
// OS time-sync probe, the boot id, path-permission checks, clocks, timers).
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  PROVISION_QUESTIONS,
  isInteractive,
  provisionQuota,
} from "../../src/backend/storage/provision-quota.js";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import {
  BackendStore,
  configureDatabase,
  type StartupStoreAccess,
} from "../../src/backend/storage/store.js";
import type { ExclusiveLock } from "../../src/backend/storage/lock.js";
import { TOMORROW_IO } from "../../src/backend/quota/quota-guard.js";
import { createRuntimeSend } from "../../src/backend/send/provider-send-gate.js";
import { readOsBootId } from "../../src/backend/time/boot-id.js";

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) =>
    (args.at(-1) as (e: Error | null, out: string) => void)(null, "yes\n"),
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
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) h.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
/** Fresh v3 database as `provision:backend` + migration leave it: no Quota
 * Metadata yet (UNPROVISIONED).
 */
function freshV3(version = 3) {
  const dir = mkdtempSync(join(tmpdir(), "signage-provision-quota-"));
  dirs.push(dir);
  const path = join(dir, "signage.db");
  const db = new Database(path);
  initializeSchema(db);
  if (version === 3) {
    configureDatabase(db, 3);
    db.exec(LIFECYCLE_DDL);
    db.prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,1)").run(
      boot,
    );
  }
  db.pragma(`user_version=${version}`);
  db.close();
  const lock = {
    directory: dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock;
  return { dir, path, lock };
}
const yes = async () => "yes";
const rows = (path: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return {
      metadata: db
        .prepare(
          "SELECT provider_key, history_status, last_sequence FROM provider_quota_metadata",
        )
        .all(),
      consumptions: db
        .prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions")
        .get(),
    };
  } finally {
    db.close();
  }
};

test("asks the four F-01 conditions one by one and initializes an empty history", async () => {
  const { path, lock } = freshV3();
  const asked: string[] = [];
  const result = await provisionQuota(lock, async (question) => {
    asked.push(question);
    return "yes";
  });
  expect(result).toEqual({ outcome: "initialized" });
  expect(asked).toEqual([...PROVISION_QUESTIONS]);
  expect(rows(path)).toEqual({
    metadata: [
      { provider_key: TOMORROW_IO, history_status: "ACTIVE", last_sequence: 0 },
    ],
    consumptions: { n: 0 },
  });
});
test.each(["no", "", "y", "YES", "yes ", "はい"])(
  "anything but an exact yes (%j) refuses and writes nothing",
  async (answer) => {
    const { path, lock } = freshV3();
    const result = await provisionQuota(lock, async (q) =>
      q === PROVISION_QUESTIONS[2] ? answer : "yes",
    );
    expect(result).toEqual({
      outcome: "refused",
      reason: "initial_safety_unconfirmed",
    });
    expect(rows(path).metadata).toEqual([]);
  },
);
test("a second run is refused and does not reinitialize", async () => {
  const { path, lock } = freshV3();
  expect(await provisionQuota(lock, yes)).toEqual({ outcome: "initialized" });
  const before = rows(path);
  expect(await provisionQuota(lock, yes)).toEqual({
    outcome: "refused",
    reason: "provider_already_has_history",
  });
  expect(rows(path)).toEqual(before);
});
test("a database that is not the v3 schema is refused without any change", async () => {
  const { path, lock } = freshV3(2);
  const asked = vi.fn(yes);
  expect(await provisionQuota(lock, asked)).toEqual({
    outcome: "refused",
    reason: "schema_incompatible",
  });
  expect(asked).not.toHaveBeenCalled(); // refused before any question
  expect(rows(path).metadata).toEqual([]);
});
test("a missing database is refused (never created)", async () => {
  const { dir, lock } = freshV3();
  rmSync(join(dir, "signage.db"));
  expect(await provisionQuota(lock, yes)).toEqual({
    outcome: "refused",
    reason: "storage_error",
  });
});
test("only an interactive terminal may answer", () => {
  expect(isInteractive({ isTTY: true })).toBe(true);
  expect(isInteractive({ isTTY: false })).toBe(false);
  expect(isInteractive({})).toBe(false);
});
test("after offline Provisioning the next Startup (PROVISIONED / 0) reaches a send-ready Gate without a long wait", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  wall = Date.parse("2026-11-05T00:00:00Z");
  mono = 10_000_000_000n;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => mono);
  const { lock } = freshV3();
  expect(await provisionQuota(lock, yes)).toEqual({ outcome: "initialized" });
  // The Backend starts afterwards with the Startup Transaction, as usual.
  const h = BackendStore.openV3ForStartup(lock);
  handles.push(h);
  expect(h.startup.execute({ bootId: boot })).toMatchObject({
    outcome: "committed",
  });
  const send = createRuntimeSend(h)!;
  send.startMonitoring();
  expect(send.reservationStatus(TOMORROW_IO).allowed).toBe(false); // not yet trusted
  for (let i = 0; i < 5 * 60 + 5; i++) {
    wall += 1000;
    mono += 1_000_000_000n;
    await vi.advanceTimersByTimeAsync(1000);
  }
  // Same bound as the in-memory Provisioning case in coordinator.test.ts:
  // Trust is reached after the observation period; no 65-minute / 25-hour wait.
  expect(send.reservationStatus(TOMORROW_IO).allowed).toBe(true);
  send.stopMonitoring();
});
