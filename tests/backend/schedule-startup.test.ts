// Issue #10 startup wiring (technology-stack 18.7): the Schedule Provider is
// registered from Config + Secret once at startup; an unusable Secret disables
// only the Schedule, and nothing sensitive is logged. The real Secret
// directory is never read: loadSecret is mocked.
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startBackend } from "../../src/backend/main.js";
import { ExclusiveLock } from "../../src/backend/storage/lock.js";
import { readOsBootId } from "../../src/backend/time/boot-id.js";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import { configureDatabase } from "../../src/backend/storage/store.js";
import { loadSecret, SecretError } from "../../src/backend/config/secrets.js";
vi.mock("../../src/backend/app.js", async (original) => {
  const m = await original<typeof import("../../src/backend/app.js")>();
  return {
    ...m,
    buildApp: vi.fn((...args: Parameters<typeof m.buildApp>) => {
      const app = m.buildApp(...args);
      vi.spyOn(app, "listen").mockResolvedValue(undefined);
      return app;
    }),
  };
});
vi.mock("../../src/backend/time/boot-id.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/time/boot-id.js")>()),
  readOsBootId: vi.fn(),
}));
vi.mock("../../src/backend/storage/paths.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/storage/paths.js")>()),
  validateDatabaseFiles: vi.fn(),
}));
vi.mock("../../src/backend/config/secrets.js", async (original) => ({
  ...(await original<typeof import("../../src/backend/config/secrets.js")>()),
  loadSecret: vi.fn(),
}));
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CALENDAR = "synthetic-calendar-marker@example.test";
const dirs: string[] = [];
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
});
afterEach(() => {
  vi.mocked(loadSecret).mockReset();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function v3() {
  const dir = mkdtempSync(join(tmpdir(), "signage-schedule-startup-"));
  dirs.push(dir);
  const db = new Database(join(dir, "signage.db"));
  initializeSchema(db);
  configureDatabase(db, 3);
  db.exec(LIFECYCLE_DDL);
  db.prepare("INSERT INTO backend_lifecycle VALUES (1,'RUNNING',?,1)").run(
    boot,
  );
  db.pragma("user_version=3");
  db.close();
  vi.spyOn(ExclusiveLock, "inherited").mockReturnValue({
    directory: dir,
    assertHeld: vi.fn(),
  } as unknown as ExclusiveLock);
}
async function start(env: NodeJS.ProcessEnv) {
  v3();
  let logs = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk;
      cb();
    },
  });
  const signals = new EventEmitter();
  const result = await startBackend(env, stream, {
    signals,
    finish: vi.fn(),
  });
  await result?.shutdown.shutdown();
  return { result, logs };
}

test("unset Calendar ID: no Secret read, Schedule disabled, Backend healthy", async () => {
  const { result, logs } = await start({});
  expect(result?.status).toEqual({ state: "HEALTHY" });
  expect(loadSecret).not.toHaveBeenCalled();
  expect(logs).toContain('"event":"schedule_provider_disabled"');
  expect(logs).toContain('"reason":"calendar_id_unset"');
});

test("unreadable Secret: Schedule disabled with its class only, Backend healthy", async () => {
  vi.mocked(loadSecret).mockRejectedValue(new SecretError("permission"));
  const { result, logs } = await start({
    SIGNAGE_SCHEDULE_CALENDAR_ID: CALENDAR,
  });
  expect(result?.status).toEqual({ state: "HEALTHY" });
  expect(loadSecret).toHaveBeenCalledExactlyOnceWith("schedule");
  expect(logs).toContain('"reason":"permission"');
  expect(logs).not.toContain("marker");
});

test("an empty Calendar ID is an invalid Config: the Backend does not start", async () => {
  v3();
  await expect(
    startBackend(
      { SIGNAGE_SCHEDULE_CALENDAR_ID: "" },
      new Writable({ write: (_c, _e, cb) => cb() }),
    ),
  ).rejects.toThrow("Invalid backend configuration");
  expect(loadSecret).not.toHaveBeenCalled();
});
