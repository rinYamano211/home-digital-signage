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
import {
  StateAcquisitionCoordinator,
  type MultiHttpProvider,
  type StateProvider,
} from "../../src/backend/acquisition/coordinator.js";
import type { HttpOutcome } from "../../src/backend/http/outcome.js";
import { generateKeyPairSync } from "node:crypto";
import { serviceAccount } from "../../src/backend/schedule/google-auth.js";
import { createScheduleProvider } from "../../src/backend/schedule/provider.js";
import { createWeatherProviders } from "../../src/backend/weather/provider.js";
import { StateScheduler } from "../../src/backend/scheduler/state-scheduler.js";
import { createRainForecastProvider } from "../../src/backend/weather/tomorrow-io.js";
import { createRuntimeSend } from "../../src/backend/send/provider-send-gate.js";
import { readPublishedStates } from "../../src/backend/published-state-api.js";
import { TOMORROW_IO } from "../../src/backend/quota/quota-guard.js";
import type { ExclusiveLock } from "../../src/backend/storage/lock.js";
import { readOsBootId } from "../../src/backend/time/boot-id.js";
import { PublishedStateRepository } from "../../src/backend/storage/published-state-repository.js";
import type { RuntimeStoreAccess } from "../../src/backend/storage/store.js";
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
  mono = 0n,
  perf = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.mocked(readOsBootId).mockReturnValue(boot);
  wall = Date.parse("2026-11-05T00:00:00Z");
  mono = 10_000_000_000n;
  perf = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => mono);
  vi.spyOn(performance, "now").mockImplementation(() => perf);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    Response.json({ temperature: 18 }, { status: 200 }),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) h.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const move = (ms: number) => {
  wall += ms;
  mono += BigInt(ms) * 1_000_000n;
  perf += ms;
};
/** Committed real v3 Store; the Connection is captured for test-only checks. */
function committed(provisioned = false) {
  const dir = mkdtempSync(join(tmpdir(), "signage-coordinator-"));
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
  expect(h.startup.execute({ bootId: boot })).toMatchObject({
    outcome: "committed",
  });
  return { h, db, runtime: BackendStore.activateRuntime(h)! };
}
/** Mock Provider: Domain parsing is the Provider's job, not the Coordinator's. */
const mock = (over: Partial<StateProvider> = {}): StateProvider => ({
  stateKey: "currentWeather",
  periodMs: 600_000,
  quota: false,
  http: { url: "https://weather.example.test/now", maxBodyBytes: 4096 },
  parse(outcome) {
    if (outcome.kind !== "response" || outcome.http.status !== 200)
      return { kind: "failure" };
    return {
      kind: "success",
      data: JSON.parse(new TextDecoder().decode(outcome.body)),
      expiresAt: iso(Date.now() + 3_600_000),
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
const states = (runtime: ReturnType<typeof committed>["runtime"]) =>
  (readPublishedStates(runtime).body as { states: Record<string, unknown> })
    .states;
test("new State: one HTTP, Tx-A then Tx-P, next run waits for the period", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [mock()]);
  const start = wall;
  expect(await c.runOnce("currentWeather")).toEqual({
    kind: "scheduled",
    recheckAt: iso(start + 600_000),
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(control(db)).toEqual({
    consecutiveFailures: 0,
    nextAttemptAt: iso(start + 600_000),
  });
  expect(states(runtime).currentWeather).toEqual({
    data: { temperature: 18 },
    meta: {
      dataUpdatedAt: iso(start),
      expiresAt: iso(start + 3_600_000),
      lastAttemptAt: iso(start),
      lastAttemptResult: "success",
      publishedAt: iso(start),
      dataSource: "externalApi",
    },
  });
  move(599_000);
  expect(await c.runOnce("currentWeather")).toEqual({
    kind: "scheduled",
    recheckAt: iso(start + 600_000),
  });
  expect(fetchMock).toHaveBeenCalledOnce();
});
test("failures back off exponentially, keep published data, and success resets", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [mock()]);
  await c.runOnce("currentWeather");
  const published = states(runtime).currentWeather as {
    data: unknown;
    meta: Record<string, unknown>;
  };
  fetchMock.mockImplementation(async () => new Response("", { status: 500 }));
  move(600_000);
  const first = wall;
  await c.runOnce("currentWeather");
  expect(control(db)).toEqual({
    consecutiveFailures: 1,
    nextAttemptAt: iso(first + 60_000),
  });
  fetchMock.mockImplementation(async () => {
    throw new TypeError("network down");
  });
  move(60_000);
  const second = wall;
  await c.runOnce("currentWeather");
  expect(control(db)).toEqual({
    consecutiveFailures: 2,
    nextAttemptAt: iso(second + 120_000),
  });
  expect(states(runtime).currentWeather).toEqual({
    data: published.data,
    meta: {
      ...published.meta,
      lastAttemptAt: iso(second),
      lastAttemptResult: "failure",
      publishedAt: iso(second),
    },
  });
  fetchMock.mockImplementation(async () => Response.json({ temperature: 20 }));
  move(120_000);
  await c.runOnce("currentWeather");
  expect(control(db)).toMatchObject({ consecutiveFailures: 0 });
  expect(states(runtime).currentWeather).toMatchObject({
    data: { temperature: 20 },
  });
});
test("HTTP 429 honours Retry-After beyond the Backoff; first failure publishes data null", async () => {
  const { db, runtime } = committed();
  fetchMock.mockImplementation(
    async () =>
      new Response("", { status: 429, headers: { "Retry-After": "900" } }),
  );
  const c = new StateAcquisitionCoordinator(runtime, null, [mock()]);
  const at = wall;
  await c.runOnce("currentWeather");
  expect(control(db)).toEqual({
    consecutiveFailures: 1,
    nextAttemptAt: iso(at + 900_000),
  });
  expect(states(runtime).currentWeather).toEqual({
    data: null,
    meta: {
      dataUpdatedAt: null,
      expiresAt: null,
      lastAttemptAt: iso(at),
      lastAttemptResult: "failure",
      publishedAt: iso(at),
      dataSource: null,
    },
  });
});
test("invalid Provider data (bad expiresAt) is a failure, not a publication", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [
    mock({
      parse: () => ({ kind: "success", data: { t: 1 }, expiresAt: "later" }),
    }),
  ]);
  await c.runOnce("currentWeather");
  expect(control(db)).toMatchObject({ consecutiveFailures: 1 });
  expect(states(runtime).currentWeather).toMatchObject({ data: null });
});
test("past records without a Control Row wait 5 minutes before the initial save", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [mock()]);
  await c.runOnce("currentWeather");
  db.prepare("DELETE FROM acquisition_control").run();
  move(600_000);
  const result = await c.runOnce("currentWeather");
  expect(result).toEqual({ kind: "scheduled", recheckAt: iso(wall + 300_000) });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(control(db)).toBeNull();
  move(300_000);
  await c.runOnce("currentWeather");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(control(db)).toMatchObject({ consecutiveFailures: 0 });
});
test("an invalid Control Row holds only that State, with no HTTP or repair", async () => {
  const { db, runtime } = committed();
  db.prepare("INSERT INTO acquisition_control VALUES (?,?)").run(
    "currentWeather",
    "{broken",
  );
  const c = new StateAcquisitionCoordinator(runtime, null, [mock()]);
  expect(await c.runOnce("currentWeather")).toEqual({
    kind: "blocked",
    scope: "state",
    reason: "integrity_error",
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(
    db.prepare("SELECT control_json FROM acquisition_control").get(),
  ).toEqual({ control_json: "{broken" });
});
test.each([
  [
    "L2",
    { kind: "suspended", scope: "global", reason: "database_unavailable" },
  ],
  ["L4", { kind: "blocked", scope: "global", reason: "integrity_error" }],
] as const)("DB failure %s stops globally before HTTP", async (layer, held) => {
  const { db, runtime } = committed();
  connectionCoordination(db).blocked = {
    scope: "database",
    layer,
    reason: "synthetic",
  };
  const c = new StateAcquisitionCoordinator(runtime, null, [mock()]);
  expect(await c.runOnce("currentWeather")).toEqual(held);
  expect(fetchMock).not.toHaveBeenCalled();
});
test("no Provider: hourly re-evaluation with no HTTP or DB write", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, []);
  expect(await c.runOnce("schedule")).toEqual({
    kind: "scheduled",
    recheckAt: iso(wall + 3_600_000),
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(db.prepare("SELECT * FROM acquisition_control").all()).toEqual([]);
  expect(states(runtime)).toEqual({});
});
test("Quota Provider is suppressed without an open Gate; Control State is unchanged", async () => {
  const { h, db, runtime } = committed(true);
  const rain = mock({ stateKey: "rainForecast", quota: true });
  expect(
    await new StateAcquisitionCoordinator(runtime, null, [rain]).runOnce(
      "rainForecast",
    ),
  ).toEqual({ kind: "scheduled", recheckAt: iso(wall + 60_000) });
  const send = createRuntimeSend(h, rain.http)!; // closed until Recovery
  expect(
    await new StateAcquisitionCoordinator(runtime, send, [rain]).runOnce(
      "rainForecast",
    ),
  ).toEqual({ kind: "scheduled", recheckAt: iso(wall + 60_000) });
  send.stopMonitoring();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(control(db, "rainForecast")).toBeNull();
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions").get(),
  ).toEqual({ n: 0 });
});
test("Quota Provider: Tx-Q is committed before the single HTTP request through the Gate", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const { h, db, runtime } = committed(true);
  const rain = mock({
    stateKey: "rainForecast",
    quota: true,
    http: { url: "https://rain.example.test/v4", maxBodyBytes: 4096 },
  });
  const send = createRuntimeSend(h, rain.http)!;
  send.startMonitoring();
  for (let i = 0; i < 5 * 60 + 5; i++) {
    move(1000);
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(send.reservationStatus(TOMORROW_IO).allowed).toBe(true);
  fetchMock.mockImplementation(async () => {
    // HTTP starts only after the consumption is durable.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions").get(),
    ).toEqual({ n: 1 });
    return Response.json({ rain: 0 });
  });
  const c = new StateAcquisitionCoordinator(runtime, send, [rain]);
  await c.runOnce("rainForecast");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(String(fetchMock.mock.calls[0][0])).toBe(
    "https://rain.example.test/v4",
  );
  expect(states(runtime).rainForecast).toMatchObject({ data: { rain: 0 } });
  expect(control(db, "rainForecast")).toMatchObject({ consecutiveFailures: 0 });
  send.stopMonitoring();
});
/** Gate-ready Quota Provider whose HTTP never answers until aborted. */
async function hangingQuotaRun() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const { h, db, runtime } = committed(true);
  const rain = mock({
    stateKey: "rainForecast",
    quota: true,
    http: { url: "https://rain.example.test/v4", maxBodyBytes: 4096 },
  });
  const send = createRuntimeSend(h, rain.http)!;
  send.startMonitoring();
  for (let i = 0; i < 5 * 60 + 5; i++) {
    move(1000);
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(send.reservationStatus(TOMORROW_IO).allowed).toBe(true);
  fetchMock.mockImplementation(
    (_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const c = new StateAcquisitionCoordinator(runtime, send, [rain]);
  const run = c.runOnce("rainForecast");
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  return { db, runtime, send, c, run };
}
test("Quota Provider: Shutdown Abort of the Gate HTTP saves nothing and keeps the consumed Quota (HTTP-03)", async () => {
  const { db, runtime, send, c, run } = await hangingQuotaRun();
  c.abort();
  send.stopControl("global").stop(); // closes the Gate and aborts the HTTP
  expect(await run).toEqual({
    kind: "suspended",
    scope: "global",
    reason: "storage_unresolved",
  });
  expect(control(db, "rainForecast")).toBeNull(); // no Tx-A, no Backoff
  expect(states(runtime).rainForecast).toBeUndefined(); // no Tx-P
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions").get(),
  ).toEqual({ n: 1 }); // the consumed Quota is not cancelled
  send.stopMonitoring();
});
test("Quota Provider: a Gate Abort without Shutdown keeps the existing failure handling", async () => {
  const { db, send, run } = await hangingQuotaRun();
  send.stopControl("global").stop();
  await run;
  expect(control(db, "rainForecast")).toMatchObject({ consecutiveFailures: 1 });
  send.stopMonitoring();
});
/** Gate-ready Coordinator with the real Tomorrow.io Provider (Issue #93). */
async function gatedRainForecast() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  const { h, db, runtime } = committed(true);
  const log = { debug: vi.fn(), warn: vi.fn() };
  const rain = createRainForecastProvider({
    location: { latitude: 35.123456, longitude: 139.654321 },
    apiKey: "test_key-ABCDEFGH12345678",
    logger: log,
  });
  const send = createRuntimeSend(h, rain.http)!;
  send.startMonitoring();
  for (let i = 0; i < 5 * 60 + 5; i++) {
    move(1000);
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(send.reservationStatus(TOMORROW_IO).allowed).toBe(true);
  const c = new StateAcquisitionCoordinator(runtime, send, [rain]);
  return { db, runtime, send, c, log };
}
/** 66 one-minute slots from the current whole minute (like the real API). */
const rainTimeline = (rainy: number[] = []) => ({
  data: {
    timelines: [
      {
        timestep: "1m",
        intervals: Array.from({ length: 66 }, (_, i) => ({
          startTime: iso(Math.floor(wall / 60_000) * 60_000 + i * 60_000),
          values: { rainIntensity: rainy.includes(i) ? 0.5 : 0 },
        })),
      },
    ],
  },
});
test("Tomorrow.io Provider through the real Gate: one POST, Domain Data saved and published", async () => {
  const { db, runtime, send, c, log } = await gatedRainForecast();
  fetchMock.mockImplementation(async () =>
    Response.json(rainTimeline([20, 21])),
  );
  await c.runOnce("rainForecast");
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe(
    "https://api.tomorrow.io/v4/timelines?apikey=test_key-ABCDEFGH12345678",
  );
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toMatchObject({
    fields: ["rainIntensity"],
    timesteps: ["1m"],
    startTime: "now",
    endTime: "nowPlus65m",
  });
  expect(states(runtime).rainForecast).toMatchObject({
    data: { status: "dry", intensity: "light" },
    meta: { lastAttemptResult: "success", dataSource: "externalApi" },
  });
  expect(control(db, "rainForecast")).toMatchObject({ consecutiveFailures: 0 });
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM provider_quota_consumptions").get(),
  ).toEqual({ n: 1 }); // Tx-Q before the single HTTP
  expect(JSON.stringify(log.warn.mock.calls)).not.toContain("ABCDEFGH");
  send.stopMonitoring();
});
test("Tomorrow.io Provider: HTTP 429 is a failure that backs off with Retry-After and publishes nothing", async () => {
  const { db, runtime, send, c, log } = await gatedRainForecast();
  fetchMock.mockImplementation(
    async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "900" } }),
  );
  const before = wall;
  await c.runOnce("rainForecast");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(control(db, "rainForecast")).toMatchObject({ consecutiveFailures: 1 });
  expect(
    Date.parse(control(db, "rainForecast").nextAttemptAt) - before,
  ).toBeGreaterThanOrEqual(900_000);
  expect(states(runtime).rainForecast).toMatchObject({ data: null });
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "rate_limited" }),
    expect.any(String),
  );
  send.stopMonitoring();
});
test("Scheduler + Coordinator never run the same State concurrently", async () => {
  const { runtime } = committed();
  let release!: () => void;
  fetchMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(Response.json({ temperature: 1 }));
      }),
  );
  const scheduler = new StateScheduler(
    new StateAcquisitionCoordinator(runtime, null, [mock()]),
    { warn: () => {}, error: () => {} },
  );
  scheduler.start();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  scheduler.requestRecheck("currentWeather");
  scheduler.requestRecheck("currentWeather");
  await new Promise((r) => setTimeout(r, 20));
  expect(fetchMock).toHaveBeenCalledOnce();
  release();
  await scheduler.stop();
  expect(fetchMock).toHaveBeenCalledOnce();
});

// ---- Published State read anomalies are not "no data" (PR #78 review) ----
const quiet = { warn: () => {}, error: () => {} };
/** Test-only writer of an invalid Snapshot (bypassing the Coordinator). */
const corrupt = (db: Database.Database, key = "currentWeather") =>
  expect(
    new PublishedStateRepository(db, quiet, 3).save(
      key,
      JSON.stringify({ data: [], meta: {} }),
    ),
  ).toMatchObject({ outcome: "saved" });
const snapshots = (db: Database.Database) =>
  db.prepare("SELECT * FROM published_state_snapshots ORDER BY 1, 2").all();
/** Runtime whose Published State read returns a forced result. */
const forcedRead = (
  runtime: RuntimeStoreAccess,
  result: ReturnType<RuntimeStoreAccess["publishedStates"]["read"]>,
): RuntimeStoreAccess => ({
  ...runtime,
  publishedStates: { ...runtime.publishedStates, read: () => result as never },
});
const held = { kind: "blocked", scope: "state", reason: "integrity_error" };
test("Control Row present + isolated Snapshot: no HTTP, Tx-A or Tx-P; nothing overwritten", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [mock()]);
  await c.runOnce("currentWeather");
  corrupt(db);
  corrupt(db); // both retained generations invalid -> isolated
  expect(states(runtime).currentWeather).toBeUndefined();
  const before = { control: control(db), snapshots: snapshots(db) };
  fetchMock.mockImplementation(async () => new Response("", { status: 500 }));
  move(600_000);
  expect(await c.runOnce("currentWeather")).toEqual(held);
  expect(fetchMock).toHaveBeenCalledOnce(); // only the first, successful run
  expect({ control: control(db), snapshots: snapshots(db) }).toEqual(before);
});
test("Control Row present + validator_error: no HTTP, Tx-A or Tx-P", async () => {
  const { db, runtime } = committed();
  await new StateAcquisitionCoordinator(runtime, null, [mock()]).runOnce(
    "currentWeather",
  );
  const before = { control: control(db), snapshots: snapshots(db) };
  move(600_000);
  const c = new StateAcquisitionCoordinator(
    forcedRead(runtime, {
      outcome: "validator_error",
      stage: "schema",
      reason: "validator_threw",
    }),
    null,
    [mock()],
  );
  expect(await c.runOnce("currentWeather")).toEqual(held);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect({ control: control(db), snapshots: snapshots(db) }).toEqual(before);
});
test.each(["isolated", "validator_error"] as const)(
  "Control Row missing + %s: no HTTP, Tx-A or Tx-P, even after the 5-minute wait",
  async (kind) => {
    const { db, runtime } = committed();
    let store = runtime;
    if (kind === "isolated") corrupt(db);
    else
      store = forcedRead(runtime, {
        outcome: "validator_error",
        stage: "semantic",
        reason: "validator_threw",
      });
    const before = snapshots(db);
    const c = new StateAcquisitionCoordinator(store, null, [mock()]);
    expect(await c.runOnce("currentWeather")).toEqual(held);
    move(300_000);
    expect(await c.runOnce("currentWeather")).toEqual(held);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(control(db)).toBeNull();
    expect(snapshots(db)).toEqual(before);
  },
);
test("a valid previous generation stays usable: failure keeps its data and saves", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [mock()]);
  await c.runOnce("currentWeather");
  corrupt(db); // latest invalid, previous valid -> previous
  fetchMock.mockImplementation(async () => new Response("", { status: 500 }));
  move(600_000);
  await c.runOnce("currentWeather");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(control(db)).toMatchObject({ consecutiveFailures: 1 });
  expect(states(runtime).currentWeather).toMatchObject({
    data: { temperature: 18 },
    meta: { lastAttemptResult: "failure" },
  });
});
test.each([
  [
    "L1",
    { kind: "suspended", scope: "global", reason: "database_unavailable" },
  ],
  [
    "L2",
    { kind: "suspended", scope: "global", reason: "database_unavailable" },
  ],
  ["L3", { kind: "blocked", scope: "global", reason: "integrity_error" }],
  ["L4", { kind: "blocked", scope: "global", reason: "integrity_error" }],
] as const)(
  "Published State database_error %s keeps the DB failure mapping before HTTP",
  async (layer, result) => {
    const { db, runtime } = committed();
    const c = new StateAcquisitionCoordinator(
      forcedRead(runtime, {
        outcome: "database_error",
        layer,
        reason: "synthetic",
      }),
      null,
      [mock()],
    );
    expect(await c.runOnce("currentWeather")).toEqual(result);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(control(db)).toBeNull();
  },
);

// ---- Issue #10 (technology-stack 18.7): multi-HTTP, Abort, discard, period ----
const decode = (o: HttpOutcome) =>
  o.kind === "response" ? JSON.parse(new TextDecoder().decode(o.body)) : null;
const failureOf = (o: HttpOutcome) =>
  o.http
    ? {
        kind: "failure" as const,
        httpStatus: o.http.status,
        ...(o.http.retryAfter !== undefined
          ? { retryAfter: o.http.retryAfter }
          : {}),
      }
    : { kind: "failure" as const };
/** Mock multi-HTTP Provider: a token POST and two pages, all via ctx.http. */
const multi = (over: Partial<MultiHttpProvider> = {}): MultiHttpProvider => ({
  stateKey: "currentWeather",
  periodMs: 600_000,
  quota: false,
  async acquire(ctx) {
    const token = await ctx.http({
      url: "https://auth.example.test/token",
      maxBodyBytes: 4096,
      method: "POST",
      body: "grant=synthetic",
    });
    if (token.kind !== "response" || token.http.status !== 200)
      return failureOf(token);
    const pages: unknown[] = [];
    for (const page of [1, 2]) {
      const r = await ctx.http({
        url: `https://calendar.example.test/page${page}`,
        maxBodyBytes: 4096,
      });
      if (r.kind !== "response" || r.http.status !== 200) return failureOf(r);
      pages.push(decode(r));
    }
    return {
      kind: "success",
      data: { pages },
      expiresAt: iso(Date.now() + 3_600_000),
    };
  },
  ...over,
});
/** fetch that never answers and rejects only when its signal aborts. */
const hanging: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++)
    await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
};
test("multi-HTTP Provider: POST then pages through the common Adapter, one Tx-A / Tx-P", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [multi()]);
  const start = wall;
  expect(await c.runOnce("currentWeather")).toEqual({
    kind: "scheduled",
    recheckAt: iso(start + 600_000),
  });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    body: "grant=synthetic",
  });
  expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("method");
  expect(control(db)).toEqual({
    consecutiveFailures: 0,
    nextAttemptAt: iso(start + 600_000),
  });
  expect(states(runtime).currentWeather).toMatchObject({
    data: { pages: [{ temperature: 18 }, { temperature: 18 }] },
    meta: { lastAttemptResult: "success", dataSource: "externalApi" },
  });
});
test("multi-HTTP failure carries HTTP 429 and Retry-After into the Backoff", async () => {
  const { db, runtime } = committed();
  let call = 0;
  fetchMock.mockImplementation(async () =>
    ++call === 3
      ? new Response("", { status: 429, headers: { "Retry-After": "900" } })
      : Response.json({ temperature: 18 }),
  );
  const c = new StateAcquisitionCoordinator(runtime, null, [multi()]);
  const at = wall;
  await c.runOnce("currentWeather");
  expect(control(db)).toEqual({
    consecutiveFailures: 1,
    nextAttemptAt: iso(at + 900_000),
  });
  expect(states(runtime).currentWeather).toMatchObject({
    data: null,
    meta: { lastAttemptResult: "failure" },
  });
});
test("a throwing multi-HTTP Provider is an ordinary failure", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [
    multi({
      acquire: async () => {
        throw new Error("synthetic");
      },
    }),
  ]);
  await c.runOnce("currentWeather");
  expect(control(db)).toMatchObject({ consecutiveFailures: 1 });
});
test("discard saves nothing and only schedules a re-evaluation of the Control State", async () => {
  const { db, runtime } = committed();
  let discard = false;
  const base = multi();
  const c = new StateAcquisitionCoordinator(runtime, null, [
    multi({
      acquire: async (ctx) =>
        discard ? { kind: "discard" } : base.acquire(ctx),
    }),
  ]);
  await c.runOnce("currentWeather");
  const savedControl = control(db);
  const savedState = states(runtime).currentWeather;
  move(600_000);
  discard = true;
  expect(await c.runOnce("currentWeather")).toEqual({
    kind: "scheduled",
    recheckAt: iso(wall + 1000),
  });
  expect(control(db)).toEqual(savedControl);
  expect(states(runtime).currentWeather).toEqual(savedState);
  // The re-evaluation is the normal cycle: still due, so it acquires again.
  discard = false;
  move(1000);
  const calls = fetchMock.mock.calls.length;
  await c.runOnce("currentWeather");
  expect(fetchMock.mock.calls.length).toBe(calls + 3);
  expect(control(db)).toEqual({
    consecutiveFailures: 0,
    nextAttemptAt: iso(wall + 600_000),
  });
});
test("a re-evaluation after discard still waits for a future nextAttemptAt", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [
    multi({ acquire: async () => ({ kind: "discard" }) }),
  ]);
  // Seed a due-later Control Row through a normal success first.
  const ok = new StateAcquisitionCoordinator(runtime, null, [multi()]);
  await ok.runOnce("currentWeather");
  const due = control(db).nextAttemptAt as string;
  const calls = fetchMock.mock.calls.length;
  expect(await c.runOnce("currentWeather")).toEqual({
    kind: "scheduled",
    recheckAt: due,
  });
  expect(fetchMock.mock.calls.length).toBe(calls);
});
test("discard on the first attempt keeps the State new (no Control Row)", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [
    multi({ acquire: async () => ({ kind: "discard" }) }),
  ]);
  expect(await c.runOnce("currentWeather")).toEqual({
    kind: "scheduled",
    recheckAt: iso(wall + 1000),
  });
  expect(control(db)).toBeNull();
  expect(states(runtime).currentWeather).toBeUndefined();
});
test.each([
  [1000, 1000],
  [0, 600_000],
  [600_000, 600_000],
  [700_000, 600_000],
  [Number.NaN, 600_000],
  [1.5, 600_000],
])(
  "nextPeriodMs %s shortens only a successful period (expected %s)",
  async (value, expected) => {
    const { db, runtime } = committed();
    const c = new StateAcquisitionCoordinator(runtime, null, [
      mock({ nextPeriodMs: () => value }),
    ]);
    const start = wall;
    await c.runOnce("currentWeather");
    expect(control(db)).toEqual({
      consecutiveFailures: 0,
      nextAttemptAt: iso(start + expected),
    });
  },
);
test("nextPeriodMs never changes the failure Backoff", async () => {
  const { db, runtime } = committed();
  fetchMock.mockImplementation(async () => new Response("", { status: 500 }));
  const c = new StateAcquisitionCoordinator(runtime, null, [
    mock({ nextPeriodMs: () => 1000 }),
  ]);
  const at = wall;
  await c.runOnce("currentWeather");
  expect(control(db)).toEqual({
    consecutiveFailures: 1,
    nextAttemptAt: iso(at + 60_000),
  });
});
test("a throwing nextPeriodMs falls back to the normal period", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [
    mock({
      nextPeriodMs: () => {
        throw new Error("synthetic");
      },
    }),
  ]);
  const start = wall;
  await c.runOnce("currentWeather");
  expect(control(db)).toMatchObject({ nextAttemptAt: iso(start + 600_000) });
});
test.each([
  ["multi-HTTP", () => multi()],
  ["single-HTTP (no quota)", () => mock()],
])(
  "abort() stops an in-flight %s attempt with no Tx-A / Tx-P and no new attempt",
  async (_name, make) => {
    const { db, runtime } = committed();
    fetchMock.mockImplementation(hanging);
    const c = new StateAcquisitionCoordinator(runtime, null, [make()]);
    const running = c.runOnce("currentWeather");
    await until(() => fetchMock.mock.calls.length === 1);
    c.abort();
    expect(await running).toEqual({
      kind: "suspended",
      scope: "global",
      reason: "storage_unresolved",
    });
    expect(control(db)).toBeNull();
    expect(states(runtime).currentWeather).toBeUndefined();
    expect(await c.runOnce("currentWeather")).toMatchObject({
      kind: "suspended",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  },
);
test("abort() during a later page stops the attempt and keeps the earlier publication", async () => {
  const { db, runtime } = committed();
  const c = new StateAcquisitionCoordinator(runtime, null, [multi()]);
  await c.runOnce("currentWeather");
  const savedControl = control(db);
  const savedState = states(runtime).currentWeather;
  move(600_000);
  let call = 0;
  fetchMock.mockImplementation((input, init) =>
    ++call < 3
      ? Promise.resolve(Response.json({ t: 1 }))
      : hanging(input, init),
  );
  const running = c.runOnce("currentWeather");
  await until(() => call === 3);
  c.abort();
  expect(await running).toMatchObject({ kind: "suspended", scope: "global" });
  expect(control(db)).toEqual(savedControl);
  expect(states(runtime).currentWeather).toEqual(savedState);
});
test("a multi-HTTP Provider cannot use the Quota path", () => {
  const { runtime } = committed();
  expect(
    () =>
      new StateAcquisitionCoordinator(runtime, null, [
        { ...multi(), quota: true } as unknown as MultiHttpProvider,
      ]),
  ).toThrow(new TypeError("Quota Providers must be single-HTTP"));
});

// Adapter contract violations: the Request end is not proven (technology-stack
// 18.7). The attempt is an ordinary failure for Tx-A, and the State starts no
// new HTTP until the Lifecycle end is proven, like the Send Gate occupancy.
const violations: [string, () => void][] = [
  [
    "fetch returns no Promise",
    () =>
      fetchMock.mockImplementation(
        () => Response.json({}) as unknown as Promise<Response>,
      ),
  ],
  [
    "the Body yields a non-byte chunk",
    () =>
      fetchMock.mockImplementation(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue("text");
                c.close();
              },
            }),
          ),
      ),
  ],
];
test.each(
  violations.flatMap(([name, arrange]) => [
    [name, "single-HTTP", arrange, () => mock()] as const,
    [name, "multi-HTTP", arrange, () => multi()] as const,
  ]),
)(
  "%s (%s): failure for Tx-A, then no new HTTP while the end is unproven",
  async (_name, _type, arrange, make) => {
    const { db, runtime } = committed();
    arrange();
    const c = new StateAcquisitionCoordinator(runtime, null, [make()]);
    const at = wall;
    await c.runOnce("currentWeather");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(control(db)).toEqual({
      consecutiveFailures: 1,
      nextAttemptAt: iso(at + 60_000),
    });
    move(60_000);
    fetchMock.mockImplementation(async () => Response.json({ t: 1 }));
    expect(await c.runOnce("currentWeather")).toEqual({
      kind: "scheduled",
      recheckAt: iso(wall + 60_000),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(control(db)).toMatchObject({ consecutiveFailures: 1 });
    let drained = false;
    void c.drain().then(() => (drained = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
  },
);
test("a proven end (ordinary failure or success) never occupies the State and drains", async () => {
  const { db, runtime } = committed();
  fetchMock.mockImplementation(async () => new Response("", { status: 500 }));
  const c = new StateAcquisitionCoordinator(runtime, null, [multi()]);
  await c.runOnce("currentWeather");
  await c.drain();
  move(60_000);
  fetchMock.mockImplementation(async () => Response.json({ t: 1 }));
  await c.runOnce("currentWeather");
  expect(control(db)).toMatchObject({ consecutiveFailures: 0 });
  await c.drain();
});
test("an unproven end does not affect another State", async () => {
  const { db, runtime } = committed();
  fetchMock.mockImplementation(
    () => Response.json({}) as unknown as Promise<Response>,
  );
  const c = new StateAcquisitionCoordinator(runtime, null, [
    mock(),
    mock({
      stateKey: "weeklyWeather",
      http: { url: "https://weekly.example.test/", maxBodyBytes: 4096 },
    }),
  ]);
  await c.runOnce("currentWeather");
  fetchMock.mockImplementation(async () => Response.json({ t: 1 }));
  await c.runOnce("weeklyWeather");
  expect(control(db, "weeklyWeather")).toMatchObject({
    consecutiveFailures: 0,
  });
});

// ---- Issue #10: the Google Calendar Provider through the real Coordinator ----
test("Schedule Provider end to end: Tx-A / Tx-P and the Published State API", async () => {
  const { db, runtime } = committed();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = serviceAccount({
    type: "service_account",
    client_email: "signage-test@synthetic.example.test",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  })!;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return Response.json({ access_token: "synthetic", expires_in: 3600 });
    return Response.json({
      items: [
        {
          id: "e1",
          summary: "Synthetic",
          start: { dateTime: "2026-11-05T10:00:00+09:00" },
          end: { dateTime: "2026-11-05T11:00:00+09:00" },
        },
      ],
    });
  });
  const c = new StateAcquisitionCoordinator(runtime, null, [
    createScheduleProvider({
      calendarId: "synthetic@example.test",
      account,
      logger: logger as never,
    }),
  ]);
  const start = wall; // 2026-11-05 09:00 JST
  await c.runOnce("schedule");
  expect(control(db, "schedule")).toEqual({
    consecutiveFailures: 0,
    nextAttemptAt: iso(start + 600_000),
  });
  expect(states(runtime).schedule).toEqual({
    data: {
      date: "2026-11-05",
      events: [
        {
          id: "e1",
          title: "Synthetic",
          allDay: false,
          startAt: "2026-11-05T01:00:00.000Z",
          endAt: "2026-11-05T02:00:00.000Z",
        },
      ],
    },
    meta: {
      dataUpdatedAt: iso(start),
      expiresAt: iso(start + 6 * 3_600_000),
      lastAttemptAt: iso(start),
      lastAttemptResult: "success",
      publishedAt: iso(start),
      dataSource: "externalApi",
    },
  });
  // Next JST day: the API hides the old date even within the TTL (10.8).
  move(15 * 3_600_000);
  expect(states(runtime).schedule).toMatchObject({ data: null });
});

// ---- Issue #9: the Open-Meteo Providers through the real Coordinator ----
test("Weather Providers end to end: Tx-A / Tx-P, Cache on failure, no location stored", async () => {
  const { db, runtime } = committed();
  const H = 3_600_000;
  const local = (ms: number) => new Date(ms + 9 * H).toISOString().slice(0, 16);
  const day0 = Date.parse("2026-11-04T15:00:00Z"); // 11/05 00:00 JST
  const time = Array.from({ length: 72 }, (_, i) => local(day0 + i * H));
  const dates = Array.from({ length: 9 }, (_, i) =>
    local(day0 + i * 24 * H).slice(0, 10),
  );
  const envelope = {
    latitude: 12.375,
    longitude: -123.5,
    utc_offset_seconds: 32400,
  };
  let failing = false;
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (failing) return new Response("", { status: 503 });
    if (url.searchParams.has("current"))
      return Response.json({
        ...envelope,
        current: {
          time: local(wall - 15 * 60_000),
          interval: 900,
          temperature_2m: 14.2,
          weather_code: 3,
          is_day: 1,
        },
      });
    if (url.searchParams.has("hourly"))
      return Response.json({
        ...envelope,
        hourly: {
          time,
          temperature_2m: time.map(() => 12),
          weather_code: time.map(() => 2),
          precipitation_probability: time.map(() => 30),
        },
      });
    return Response.json({
      ...envelope,
      daily: {
        time: dates,
        weather_code: dates.map(() => 61),
        temperature_2m_max: dates.map(() => 18),
        temperature_2m_min: dates.map(() => 8),
        precipitation_probability_max: dates.map(() => 40),
      },
    });
  });
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const c = new StateAcquisitionCoordinator(
    runtime,
    null,
    createWeatherProviders(
      { latitude: 12.345678, longitude: -123.456789 },
      logger as never,
    ),
  );
  const start = wall; // 2026-11-05 09:00 JST
  for (const key of [
    "currentWeather",
    "hourlyWeather",
    "weeklyWeather",
  ] as const)
    await c.runOnce(key);
  expect(fetchMock).toHaveBeenCalledTimes(3); // one Request per State
  expect(control(db, "currentWeather")).toEqual({
    consecutiveFailures: 0,
    nextAttemptAt: iso(start + 15 * 60_000),
  });
  expect(control(db, "hourlyWeather")).toEqual({
    consecutiveFailures: 0,
    nextAttemptAt: iso(start + 30 * 60_000),
  });
  expect(control(db, "weeklyWeather")).toEqual({
    consecutiveFailures: 0,
    nextAttemptAt: iso(start + 6 * H),
  });
  const published = states(runtime) as Record<
    string,
    { data: Record<string, unknown[]>; meta: Record<string, unknown> }
  >;
  expect(published.currentWeather).toEqual({
    data: {
      temperatureC: 14.2,
      weatherCode: 3,
      isDay: true,
      validAt: iso(start - 15 * 60_000),
    },
    meta: {
      dataUpdatedAt: iso(start),
      expiresAt: iso(start + 2 * H),
      lastAttemptAt: iso(start),
      lastAttemptResult: "success",
      publishedAt: iso(start),
      dataSource: "externalApi",
    },
  });
  expect(published.hourlyWeather!.data.hours).toHaveLength(36);
  expect(published.hourlyWeather!.data.hours![0]).toMatchObject({
    validAt: iso(start), // 09:00 JST exactly
  });
  expect(published.hourlyWeather!.meta.expiresAt).toBe(iso(start + 2 * H));
  expect(published.weeklyWeather!.data.days).toHaveLength(9);
  expect(published.weeklyWeather!.meta.expiresAt).toBe(iso(start + 12 * H));

  // A failure within the TTL keeps the Cache and records the failed attempt.
  failing = true;
  move(15 * 60_000);
  await c.runOnce("currentWeather");
  expect(states(runtime).currentWeather).toMatchObject({
    data: { temperatureC: 14.2 },
    meta: {
      dataUpdatedAt: iso(start),
      expiresAt: iso(start + 2 * H),
      lastAttemptResult: "failure",
    },
  });
  expect(logger.warn).toHaveBeenCalledWith(
    {
      event: "weather_acquisition_failed",
      stateKey: "currentWeather",
      reason: "server_error",
      httpStatus: 503,
    },
    "Weather acquisition failed",
  );
  // Past the TTL the API masks the data (10.8).
  move(2 * H);
  expect(states(runtime).currentWeather).toMatchObject({ data: null });

  // Neither the location nor the grid point is stored, published or logged.
  const stored = JSON.stringify([
    db.prepare("SELECT * FROM published_state_snapshots").all(),
    db.prepare("SELECT * FROM backend_cache").all(),
    db.prepare("SELECT * FROM acquisition_control").all(),
  ]);
  for (const s of ["12.345678", "123.456789", "12.375", "123.5"]) {
    expect(stored).not.toContain(s);
    expect(JSON.stringify(states(runtime))).not.toContain(s);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(s);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(s);
  }
});
