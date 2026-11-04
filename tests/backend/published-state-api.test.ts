import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp, registerRoutes } from "../../src/backend/app.js";
import { createLogger } from "../../src/backend/logging/logger.js";
import {
  readPublishedStates,
  type PublishedState,
} from "../../src/backend/published-state-api.js";
import { initializeSchema } from "../../src/backend/storage/schema.js";
import { LIFECYCLE_DDL } from "../../src/backend/storage/lifecycle-ddl.js";
import {
  BackendStore,
  configureDatabase,
  type StartupStoreAccess,
} from "../../src/backend/storage/store.js";
import { PublishedStateRepository } from "../../src/backend/storage/published-state-repository.js";
import { BackendCacheRepository } from "../../src/backend/storage/backend-cache-repository.js";
import { AcquisitionControlRepository } from "../../src/backend/storage/acquisition-control-repository.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
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
const now = Date.parse("2026-11-04T03:00:00Z"); // 12:00 Asia/Tokyo
const dirs: string[] = [];
const handles: StartupStoreAccess[] = [];
const quiet = { warn: () => {}, error: () => {} };
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) h.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
/** Committed real v3 Store; the Connection is captured for test-only writes. */
function committed() {
  const dir = mkdtempSync(join(tmpdir(), "signage-published-api-"));
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
  expect(h.startup.execute({ bootId: boot })).toMatchObject({
    outcome: "committed",
  });
  const runtime = BackendStore.activateRuntime(h)!;
  // Test-only writer standing in for the future Coordinator (C-Impl-5C).
  const writer = new PublishedStateRepository(db, quiet, 3);
  const save = (key: string, snapshot: unknown) =>
    expect(writer.save(key, JSON.stringify(snapshot))).toMatchObject({
      outcome: "saved",
    });
  return { h, db, runtime, save };
}
const meta = (over: Partial<PublishedState["meta"]> = {}) => ({
  dataUpdatedAt: "2026-11-04T02:50:00Z",
  expiresAt: "2026-11-04T03:30:00Z",
  lastAttemptAt: "2026-11-04T02:50:00Z",
  lastAttemptResult: "success",
  publishedAt: "2026-11-04T02:50:01Z",
  dataSource: "externalApi",
  ...over,
});
async function get(response: () => ReturnType<typeof readPublishedStates>) {
  const app = buildApp(createLogger("silent"), false);
  registerRoutes(app, response);
  try {
    const r = await app.inject({ url: "/api/published-states" });
    return { status: r.statusCode, body: r.json() as unknown };
  } finally {
    await app.close();
  }
}
test("v3 Connection: Published State, Cache and Control Repositories validate Schema v3", () => {
  const { db } = committed();
  const validator = {
    schema: (v: unknown) => ({ valid: true as const, value: v }),
    semantic: (v: unknown) => ({ valid: true as const, value: v }),
  };
  expect(
    new PublishedStateRepository(db, quiet, 3).read("schedule", validator),
  ).toMatchObject({ outcome: "empty" });
  expect(
    new BackendCacheRepository(db, quiet, 3).read("schedule", validator),
  ).toMatchObject({ outcome: "empty" });
  const control = new AcquisitionControlRepository(db, undefined, 3);
  control.context.beginAttempt("schedule");
  expect(control.read("schedule")).not.toMatchObject({
    outcome: "database_error",
  });
  // The v2 default still refuses this v3 Connection (Fail Closed).
  expect(
    new PublishedStateRepository(db, quiet).read("schedule", validator),
  ).toMatchObject({ outcome: "database_error" });
});
test("200 with schemaVersion 1; unpublished States are omitted", async () => {
  const { runtime, save } = committed();
  expect(await get(() => readPublishedStates(runtime, now))).toEqual({
    status: 200,
    body: { schemaVersion: 1, states: {} },
  });
  const current = { data: { temperature: 18 }, meta: meta() };
  save("currentWeather", current);
  const never = {
    data: null,
    meta: meta({
      dataUpdatedAt: null,
      expiresAt: null,
      lastAttemptAt: null,
      lastAttemptResult: null,
      dataSource: null,
    }),
  };
  save("weeklyWeather", never);
  expect(await get(() => readPublishedStates(runtime, now))).toEqual({
    status: 200,
    body: {
      schemaVersion: 1,
      states: { currentWeather: current, weeklyWeather: never },
    },
  });
});
test("expired data is masked without changing history or publishedAt", async () => {
  const { runtime, save } = committed();
  const stored = {
    data: { temperature: 18 },
    meta: meta({ expiresAt: "2026-11-04T03:00:00Z", dataSource: "cache" }),
  };
  save("currentWeather", stored);
  const { states } = readPublishedStates(runtime, now).body as {
    states: Record<string, PublishedState>;
  };
  expect(states.currentWeather).toEqual({
    data: null,
    meta: { ...stored.meta, dataSource: null },
  });
  expect(
    readPublishedStates(runtime, now - 1).body as { states: unknown },
  ).toMatchObject({ states: { currentWeather: stored } });
});
test("Schedule for another Asia/Tokyo date is masked even within TTL", async () => {
  const { runtime, save } = committed();
  const schedule = (date: string) => ({
    data: { date, events: [] },
    meta: meta(),
  });
  save("schedule", schedule("2026-11-04"));
  expect(readPublishedStates(runtime, now).body).toMatchObject({
    states: { schedule: schedule("2026-11-04") },
  });
  // 2026-11-04T15:00Z is already 2026-11-05 in Asia/Tokyo.
  const late = Date.parse("2026-11-04T15:00:00Z");
  save("schedule", {
    ...schedule("2026-11-04"),
    meta: meta({ expiresAt: "2026-11-05T00:00:00Z" }),
  });
  expect(readPublishedStates(runtime, late).body).toMatchObject({
    states: {
      schedule: {
        data: null,
        meta: { dataSource: null, expiresAt: "2026-11-05T00:00:00Z" },
      },
    },
  });
});
test.each([
  ["extra top-level key", { data: null, meta: meta(), extra: 1 }],
  ["array data", { data: [], meta: meta() }],
  ["non-UTC timestamp", { data: {}, meta: meta({ publishedAt: "now" }) }],
  ["data without expiresAt", { data: {}, meta: meta({ expiresAt: null }) }],
  ["null data with a source", { data: null, meta: meta() }],
  ["half attempt", { data: {}, meta: meta({ lastAttemptResult: null }) }],
])("invalid State (%s) is omitted; other States remain", async (_, bad) => {
  const { runtime, save } = committed();
  save("rainForecast", bad);
  const good = { data: { temperature: 18 }, meta: meta() };
  save("currentWeather", good);
  expect(await get(() => readPublishedStates(runtime, now))).toEqual({
    status: 200,
    body: { schemaVersion: 1, states: { currentWeather: good } },
  });
});
test("503 without states when Runtime is absent, the DB is blocked or closed", async () => {
  const unavailable = {
    status: 503,
    body: { error: "database_unavailable" },
  };
  expect(await get(() => readPublishedStates(null, now))).toEqual(unavailable);
  const { h, db, runtime } = committed();
  connectionCoordination(db).blocked = {
    scope: "database",
    layer: "L4",
    reason: "synthetic",
  };
  expect(await get(() => readPublishedStates(runtime, now))).toEqual(
    unavailable,
  );
  connectionCoordination(db).blocked = undefined;
  h.close();
  expect(await get(() => readPublishedStates(runtime, now))).toEqual(
    unavailable,
  );
  // The default Route without a Store is also 503.
  const app = buildApp(createLogger("silent"));
  try {
    expect(
      (await app.inject({ url: "/api/published-states" })).statusCode,
    ).toBe(503);
  } finally {
    await app.close();
  }
});
