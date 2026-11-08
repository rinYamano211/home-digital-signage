// Issue #9 startup wiring (technology-stack 16.6): the three Weather Providers
// are registered from the location Config once at startup; unset disables
// only the weather. The location is never logged. No network: fetch is mocked.
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
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const LATITUDE = "12.345678";
const LONGITUDE = "-123.456789";
const dirs: string[] = [];
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("", { status: 503 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function v3() {
  const dir = mkdtempSync(join(tmpdir(), "signage-weather-startup-"));
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
  const result = await startBackend(env, stream, {
    signals: new EventEmitter(),
    finish: vi.fn(),
  });
  await result?.shutdown.shutdown();
  return { result, logs };
}

test("unset location: Weather disabled with location_unset, Backend healthy", async () => {
  const { result, logs } = await start({});
  expect(result?.status).toEqual({ state: "HEALTHY" });
  expect(logs).toContain('"event":"weather_provider_disabled"');
  expect(logs).toContain('"reason":"location_unset"');
  expect(logs).not.toContain("weather_provider_enabled");
});

test("a location registers the Weather Providers without logging it", async () => {
  const { result, logs } = await start({
    SIGNAGE_WEATHER_LATITUDE: LATITUDE,
    SIGNAGE_WEATHER_LONGITUDE: LONGITUDE,
  });
  expect(result?.status).toEqual({ state: "HEALTHY" });
  expect(logs).toContain('"event":"weather_provider_enabled"');
  expect(logs).not.toContain("weather_provider_disabled");
  for (const s of ["12.345678", "123.456789", "open-meteo"])
    expect(logs).not.toContain(s);
});

test.each([
  ["only the latitude", { SIGNAGE_WEATHER_LATITUDE: LATITUDE }],
  ["only the longitude", { SIGNAGE_WEATHER_LONGITUDE: LONGITUDE }],
  [
    "an out-of-range latitude",
    { SIGNAGE_WEATHER_LATITUDE: "91", SIGNAGE_WEATHER_LONGITUDE: LONGITUDE },
  ],
])(
  "%s is an invalid Config: the Backend does not start",
  async (_label, env) => {
    v3();
    let logs = "";
    await expect(
      startBackend(
        env,
        new Writable({
          write(chunk, _e, cb) {
            logs += chunk;
            cb();
          },
        }),
      ),
    ).rejects.toThrow("Invalid backend configuration");
    expect(logs).toContain('"event":"config_invalid"');
    for (const s of ["12.345678", "123.456789"]) expect(logs).not.toContain(s);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
