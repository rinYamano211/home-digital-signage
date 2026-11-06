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
  type RuntimeStoreAccess,
  type StartupStoreAccess,
} from "../../src/backend/storage/store.js";
import { connectionCoordination } from "../../src/backend/storage/connection-coordination.js";
import {
  StateAcquisitionCoordinator,
  type StateProvider,
} from "../../src/backend/acquisition/coordinator.js";
import { readPublishedStates } from "../../src/backend/published-state-api.js";
import type { HttpOutcome } from "../../src/backend/http/outcome.js";
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
/** C-Impl-6 PR-C acceptance across Store, Coordinator, Published State API and
 * restart (SCH IDs from technology-stack 23.8). The production Provider
 * registry is empty, so the flow is assembled here with Mock Providers.
 */
const boot = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dirs: string[] = [];
const handles: StartupStoreAccess[] = [];
let wall = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
  wall = Date.parse("2026-11-06T00:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ temperature: 18 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) h.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), "signage-pr-c-acceptance-"));
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
  return dir;
}
/** One Backend Process lifetime: open the restricted Store and commit Startup. */
function start(dir: string) {
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
  return { h, db, runtime: BackendStore.activateRuntime(h)! };
}
const provider = (
  stateKey: StateProvider["stateKey"],
  over: Partial<StateProvider> = {},
): StateProvider => ({
  stateKey,
  periodMs: 600_000,
  quota: false,
  http: { url: `https://${stateKey}.example.test/`, maxBodyBytes: 4096 },
  parse(outcome) {
    if (outcome.kind !== "response" || outcome.http.status !== 200)
      return { kind: "failure" };
    return {
      kind: "success",
      data: JSON.parse(new TextDecoder().decode(outcome.body)),
      expiresAt: iso(Date.now() + 300_000),
    };
  },
  ...over,
});
const control = (db: Database.Database, key = "currentWeather") =>
  JSON.parse(
    (
      db
        .prepare(
          "SELECT control_json FROM acquisition_control WHERE state_key=?",
        )
        .get(key) as { control_json: string } | undefined
    )?.control_json ?? "null",
  );
const api = (runtime: RuntimeStoreAccess) =>
  (
    readPublishedStates(runtime).body as unknown as {
      states: Record<string, { data: unknown; meta: Record<string, unknown> }>;
    }
  ).states;
test("SCH-01 HTTP Timeout is recorded as a failure with Backoff", async () => {
  const { db, runtime } = start(database());
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
    AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
  );
  fetchMock.mockImplementation(
    (_url, init) => Promise.reject(init!.signal!.reason) as Promise<Response>,
  );
  const seen: HttpOutcome[] = [];
  const p = provider("currentWeather");
  const c = new StateAcquisitionCoordinator(runtime, null, [
    { ...p, parse: (o) => (seen.push(o), p.parse(o)) },
  ]);
  const at = wall;
  await c.runOnce("currentWeather");
  expect(seen.map((o) => o.kind)).toEqual(["timeout"]);
  expect(control(db)).toEqual({
    consecutiveFailures: 1,
    nextAttemptAt: iso(at + 60_000),
  });
});
test.each([
  ["HTTP success", async () => Response.json({ temperature: 18 })],
  [
    "HTTP Timeout",
    async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  ],
] as const)(
  "SCH-06/28 %s then Tx-A failure: no Tx-P, no publication, Backoff not trusted",
  async (_, response) => {
    const { db, runtime } = start(database());
    fetchMock.mockImplementation(async () => {
      // The shared Connection becomes unusable before Tx-A.
      connectionCoordination(db).blocked = {
        scope: "database",
        layer: "L2",
        reason: "synthetic",
      };
      return response();
    });
    const c = new StateAcquisitionCoordinator(runtime, null, [
      provider("currentWeather"),
    ]);
    expect(await c.runOnce("currentWeather")).toEqual({
      kind: "suspended",
      scope: "global",
      reason: "database_unavailable",
    });
    connectionCoordination(db).blocked = undefined;
    expect(control(db)).toBeNull();
    expect(api(runtime)).toEqual({});
  },
);
test("SCH-23/26 restart: future nextAttemptAt is respected and expired data is masked", async () => {
  const dir = database();
  const first = start(dir);
  const started = wall;
  await new StateAcquisitionCoordinator(first.runtime, null, [
    provider("currentWeather"),
  ]).runOnce("currentWeather");
  expect(api(first.runtime).currentWeather.data).toEqual({ temperature: 18 });
  first.h.close(); // Backend stops
  wall += 360_000; // after expiresAt (+5m), before nextAttemptAt (+10m)
  const second = start(dir);
  expect(control(second.db)).toEqual({
    consecutiveFailures: 0,
    nextAttemptAt: iso(started + 600_000),
  });
  expect(api(second.runtime).currentWeather).toMatchObject({
    data: null,
    meta: {
      dataUpdatedAt: iso(started),
      expiresAt: iso(started + 300_000),
      dataSource: null,
    },
  });
  const c = new StateAcquisitionCoordinator(second.runtime, null, [
    provider("currentWeather"),
  ]);
  expect(await c.runOnce("currentWeather")).toEqual({
    kind: "scheduled",
    recheckAt: iso(started + 600_000),
  });
  expect(fetchMock).toHaveBeenCalledOnce(); // nothing right after Startup
  wall = started + 600_000;
  await c.runOnce("currentWeather");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(api(second.runtime).currentWeather.data).toEqual({ temperature: 18 });
});
test("SCH-32 TTL expiry with a Provider failure publishes no expired data but keeps Metadata", async () => {
  const { runtime } = start(database());
  const c = new StateAcquisitionCoordinator(runtime, null, [
    provider("currentWeather"),
  ]);
  const started = wall;
  await c.runOnce("currentWeather");
  fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
  wall = started + 600_000;
  await c.runOnce("currentWeather");
  expect(api(runtime).currentWeather).toEqual({
    data: null,
    meta: {
      dataUpdatedAt: iso(started),
      expiresAt: iso(started + 300_000),
      lastAttemptAt: iso(started + 600_000),
      lastAttemptResult: "failure",
      publishedAt: iso(started + 600_000),
      dataSource: null,
    },
  });
});
test("SCH-33 one State's failure does not hinder another State's acquisition", async () => {
  const { db, runtime } = start(database());
  fetchMock.mockImplementation(async (url) =>
    String(url).includes("currentweather") // hosts are lower-cased
      ? new Response("", { status: 500 })
      : Response.json({ hours: [] }),
  );
  const c = new StateAcquisitionCoordinator(runtime, null, [
    provider("currentWeather"),
    provider("hourlyWeather"),
  ]);
  await c.runOnce("currentWeather");
  await c.runOnce("hourlyWeather");
  expect(control(db, "currentWeather")).toMatchObject({
    consecutiveFailures: 1,
  });
  expect(control(db, "hourlyWeather")).toMatchObject({
    consecutiveFailures: 0,
  });
  const states = api(runtime);
  expect(states.currentWeather.data).toBeNull();
  expect(states.hourlyWeather.data).toEqual({ hours: [] });
});
