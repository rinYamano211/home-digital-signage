import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  RECHECK_INTERVAL_MS,
  StateScheduler,
  type RunOnceResult,
} from "../../src/backend/scheduler/state-scheduler.js";
import {
  STATE_KEYS,
  type StateKey,
} from "../../src/backend/storage/published-state-repository.js";
import { buildApp } from "../../src/backend/app.js";
import { createLogger } from "../../src/backend/logging/logger.js";
import { installShutdown } from "../../src/backend/shutdown.js";

const epoch = Date.parse("2030-01-01T00:00:00Z");
const scheduled = (delay = 10000): RunOnceResult => ({
  kind: "scheduled",
  recheckAt: new Date(Date.now() + delay).toISOString(),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  implementation: (key: StateKey) => Promise<RunOnceResult> = async () =>
    scheduled(),
) {
  const runOnce = vi.fn(implementation);
  const logger = { warn: vi.fn(), error: vi.fn() };
  return {
    runOnce,
    logger,
    scheduler: new StateScheduler({ runOnce }, logger),
  };
}
const callsFor = (f: ReturnType<typeof fixture>, key: StateKey) =>
  f.runOnce.mock.calls.filter(([current]) => current === key).length;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("C1-01/02/03 startup delegates all five States once without duplicate starts", async () => {
  const f = fixture();
  f.scheduler.requestRecheck("schedule");
  expect(vi.getTimerCount()).toBe(0);
  f.scheduler.start();
  f.scheduler.start();
  expect(vi.getTimerCount()).toBe(5);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.runOnce.mock.calls.map(([key]) => key)).toEqual(STATE_KEYS);
  expect(vi.getTimerCount()).toBe(5);
  await f.scheduler.stop();
});

test("C1-02/03 each State keeps an independent timer and only the requested one is replaced", async () => {
  const f = fixture(async (key) =>
    scheduled((STATE_KEYS.indexOf(key) + 1) * 1000),
  );
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  f.scheduler.requestRecheck("schedule");
  f.scheduler.requestRecheck("schedule");
  expect(vi.getTimerCount()).toBe(5);
  await vi.advanceTimersByTimeAsync(0);
  expect(callsFor(f, "schedule")).toBe(2);
  expect(callsFor(f, "currentWeather")).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(callsFor(f, "currentWeather")).toBe(2);
  expect(callsFor(f, "hourlyWeather")).toBe(1);
  await f.scheduler.stop();
});

test("C1-05/06/07/16 inFlight requests coalesce into one evaluation after completion, with no task timeout", async () => {
  const task = deferred<RunOnceResult>();
  const f = fixture(async (key) =>
    key === "schedule" ? task.promise : scheduled(100000),
  );
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20; i++) f.scheduler.requestRecheck("schedule");
  await vi.advanceTimersByTimeAsync(60000);
  expect(callsFor(f, "schedule")).toBe(1);
  // Subsequent evaluation returns a normal future reservation.
  f.runOnce.mockImplementation(async () => scheduled(100000));
  task.resolve(scheduled());
  await vi.advanceTimersByTimeAsync(1);
  expect(callsFor(f, "schedule")).toBe(2);
  expect(vi.getTimerCount()).toBe(5);
  await f.scheduler.stop();
});

test("reentrant Coordinator observes inFlight before invocation", async () => {
  const f = fixture(async (key) => {
    if (key === "schedule" && callsFor(f, key) === 1)
      f.scheduler.requestRecheck(key);
    return scheduled();
  });
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(callsFor(f, "schedule")).toBe(2);
  await f.scheduler.stop();
});

test.each(["period", "backoff", "quota"])(
  "C1-08 scheduled %s wait is opaque to Scheduler",
  async () => {
    const f = fixture(async () => scheduled(60000));
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(59999);
    expect(f.runOnce).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runOnce).toHaveBeenCalledTimes(10);
    await f.scheduler.stop();
  },
);

describe("C1-09/10/18/21/22 stop scopes", () => {
  test.each([
    { kind: "suspended", scope: "state", reason: "storage_unresolved" },
    { kind: "blocked", scope: "state", reason: "integrity_error" },
    { kind: "blocked", scope: "state", reason: "invalid_recheck_at" },
    { kind: "blocked", scope: "state", reason: "unexpected_error" },
    { kind: "suspended", scope: "global", reason: "database_unavailable" },
    { kind: "suspended", scope: "global", reason: "storage_unresolved" },
    { kind: "blocked", scope: "global", reason: "schema_incompatible" },
    { kind: "blocked", scope: "global", reason: "integrity_error" },
    { kind: "blocked", scope: "global", reason: "unexpected_error" },
  ] as RunOnceResult[])("$kind / $scope / $reason", async (result) => {
    const f = fixture(async (key) =>
      key === "schedule" ? result : scheduled(),
    );
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(
      "scope" in result && result.scope === "state" ? 4 : 0,
    );
    for (const key of STATE_KEYS) f.scheduler.requestRecheck(key);
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(10000);
    expect(callsFor(f, "schedule")).toBe(1);
    if ("scope" in result && result.scope === "state")
      expect(callsFor(f, "currentWeather")).toBeGreaterThan(1);
    else expect(f.runOnce).toHaveBeenCalledTimes(5);
    await f.scheduler.stop();
  });
});

test("global hold ignores late scheduled results and queued rechecks from another State", async () => {
  const task = deferred<RunOnceResult>();
  const f = fixture(async (key) =>
    key === "currentWeather"
      ? task.promise
      : key === "schedule"
        ? { kind: "suspended", scope: "global", reason: "database_unavailable" }
        : scheduled(),
  );
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  f.scheduler.requestRecheck("currentWeather");
  task.resolve(scheduled());
  await vi.advanceTimersByTimeAsync(10000);
  expect(vi.getTimerCount()).toBe(0);
  expect(callsFor(f, "currentWeather")).toBe(1);
  await f.scheduler.stop();
});

test.each([
  "not-a-date",
  "2030-02-30T00:00:00Z",
  "2031-02-29T00:00:00Z",
  "2030-13-01T00:00:00Z",
  "2030-01-01T24:00:00Z",
  "2030-01-01T00:60:00Z",
  "2030-01-01T00:00:60Z",
  "2030-01-01T00:01:00",
  "2030-01-01 00:01:00Z",
  "2030-01-01T09:01:00+09:00",
  "2030-01-01T00:01:00-00:00",
  " 2030-01-01T00:01:00Z",
  "2030-01-01T00:01:00Z trailing",
])("C1-20 malformed recheckAt is still held locally: %s", async (recheckAt) => {
  const f = fixture(async (key) =>
    key === "schedule" ? { kind: "scheduled", recheckAt } : scheduled(),
  );
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(4);
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      stateKey: "schedule",
      reason: "invalid_recheck_at",
      scope: "state",
    }),
    expect.any(String),
  );
  expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain(recheckAt);
  f.scheduler.requestRecheck("schedule");
  await vi.advanceTimersByTimeAsync(10000);
  expect(callsFor(f, "schedule")).toBe(1);
  await f.scheduler.stop();
});

test.each([
  "2030-01-01T00:00:01Z",
  "2030-01-01T00:00:01+00:00",
  "2030-01-01t00:00:01z",
  "2032-02-29T00:00:00.123456Z",
])("strict UTC accepts real date %s", async (recheckAt) => {
  const f = fixture(async () => ({ kind: "scheduled", recheckAt }));
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(5);
  expect(f.logger.warn).not.toHaveBeenCalled();
  await f.scheduler.stop();
});

test("C1-19 delayed Promise past reservation is deferred 60s, even with a queued recheck", async () => {
  const task = deferred<RunOnceResult>();
  const f = fixture(async (key) =>
    key === "schedule" ? task.promise : scheduled(),
  );
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  const result = scheduled(1000);
  f.scheduler.requestRecheck("schedule");
  await vi.advanceTimersByTimeAsync(2000);
  task.resolve(result);
  await vi.advanceTimersByTimeAsync(1);
  expect(callsFor(f, "schedule")).toBe(1);
  expect(vi.getTimerCount()).toBe(5); // not held
  f.runOnce.mockImplementation(async () => scheduled());
  await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS - 2);
  expect(callsFor(f, "schedule")).toBe(1); // the queued recheck did not shorten it
  await vi.advanceTimersByTimeAsync(1);
  expect(callsFor(f, "schedule")).toBe(2);
  await f.scheduler.stop();
});

test("C1-04/23/24 callback uses actual wall clock after clock movement", async () => {
  const observed: number[] = [];
  const f = fixture(async () => {
    observed.push(Date.now());
    return scheduled();
  });
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(epoch + 3600000);
  expect(f.runOnce).toHaveBeenCalledTimes(5); // no clock watcher/forward notification
  await vi.advanceTimersByTimeAsync(10000);
  expect(observed.slice(-5)).toEqual(Array(5).fill(epoch + 3610000));
  vi.setSystemTime(epoch - 3600000);
  await vi.advanceTimersByTimeAsync(10000);
  expect(observed.slice(-5)).toEqual(Array(5).fill(epoch - 3590000));
  await f.scheduler.stop();
});

test("C1-27 canceled, repeated and stopped callbacks cannot launch Tasks", async () => {
  const spy = vi.spyOn(globalThis, "setTimeout");
  const f = fixture();
  f.scheduler.start();
  const old = spy.mock.calls[4][0] as () => void;
  f.scheduler.requestRecheck("schedule");
  old();
  await vi.advanceTimersByTimeAsync(0);
  expect(callsFor(f, "schedule")).toBe(1);
  old();
  await Promise.resolve();
  expect(callsFor(f, "schedule")).toBe(1);
  const latest = spy.mock.calls.at(-1)![0] as () => void;
  await f.scheduler.stop();
  latest();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  expect(callsFor(f, "schedule")).toBe(1);
});

test("C1-28 long delay is capped and reevaluated at the intermediate boundary", async () => {
  const max = RECHECK_INTERVAL_MS;
  const spy = vi.spyOn(globalThis, "setTimeout");
  const f = fixture(async () => scheduled(max * 3));
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(spy.mock.calls.slice(-5).map(([, delay]) => delay)).toEqual(
    Array(5).fill(max),
  );
  await vi.advanceTimersByTimeAsync(max - 1);
  expect(f.runOnce).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.runOnce).toHaveBeenCalledTimes(10);
  expect(vi.getTimerCount()).toBe(5);
  await f.scheduler.stop();
});

test.each([true, false])(
  "C1-25/26 synchronous throw=%s is captured and globally held without logging error contents",
  async (sync) => {
    const f = fixture((key) => {
      if (key === "schedule") {
        if (sync) throw new Error("secret-marker");
        return Promise.reject(new Error("secret-marker"));
      }
      return Promise.resolve(scheduled());
    });
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    f.scheduler.requestRecheck("schedule");
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.runOnce).toHaveBeenCalledTimes(5);
    await f.scheduler.stop(); // rejection cannot strand inFlight
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(
      "secret-marker",
    );
  },
);

test.each([
  null,
  { kind: "unknown" },
  { kind: "blocked", scope: "state", reason: "schema_incompatible" },
  { kind: "suspended", scope: "state", reason: "database_unavailable" },
  { kind: "suspended", scope: "bad", reason: "storage_unresolved" },
])("invalid Coordinator contract fails closed globally: %j", async (result) => {
  const f = fixture(async (key) =>
    key === "schedule" ? (result as RunOnceResult) : scheduled(),
  );
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.logger.error).toHaveBeenCalled();
  await f.scheduler.stop();
});

test("logging failure does not reopen local stop or strand Task", async () => {
  const f = fixture(async () => ({
    kind: "blocked",
    scope: "state",
    reason: "integrity_error",
  }));
  f.logger.warn.mockImplementation(() => {
    throw new Error("broken logger");
  });
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  await f.scheduler.stop();
});

test("C1-11/12/13 stop synchronously cancels timers and waits every inFlight without rearming", async () => {
  const tasks = STATE_KEYS.map(() => deferred<RunOnceResult>());
  const f = fixture((key) => tasks[STATE_KEYS.indexOf(key)].promise);
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  f.scheduler.requestRecheck("schedule");
  const stopped = f.scheduler.stop();
  expect(f.scheduler.stop()).toBe(stopped);
  let finished = false;
  void stopped.then(() => {
    finished = true;
  });
  for (const key of STATE_KEYS) f.scheduler.requestRecheck(key);
  f.scheduler.start();
  for (const task of tasks.slice(0, 4)) task.resolve(scheduled());
  await vi.advanceTimersByTimeAsync(60000);
  expect(finished).toBe(false);
  expect(f.runOnce).toHaveBeenCalledTimes(5);
  expect(vi.getTimerCount()).toBe(0);
  tasks[4].resolve(scheduled());
  await stopped;
  expect(finished).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test("stop before start prevents all subsequent starts/rechecks", async () => {
  const f = fixture();
  await f.scheduler.stop();
  f.scheduler.start();
  f.scheduler.requestRecheck("schedule");
  await vi.advanceTimersByTimeAsync(1);
  expect(f.runOnce).not.toHaveBeenCalled();
});

test("stop between callback and deferred Coordinator invocation prevents new Task", async () => {
  const spy = vi.spyOn(globalThis, "setTimeout");
  const f = fixture();
  f.scheduler.start();
  (spy.mock.calls[0][0] as () => void)();
  await f.scheduler.stop();
  expect(f.runOnce).not.toHaveBeenCalled();
});

test("unknown StateKey is rejected without timers", async () => {
  const f = fixture();
  expect(() => f.scheduler.requestRecheck("unknown" as StateKey)).toThrow(
    TypeError,
  );
  await f.scheduler.stop();
});

// Exercise the existing lifecycle with injected mock work, not production wiring.
function lifecycle() {
  const task = deferred<RunOnceResult>();
  const f = fixture(async () => task.promise);
  const logger = createLogger("silent");
  const app = buildApp(logger);
  const closeDB = vi.fn();
  app.addHook("preClose", async () => {
    void f.scheduler.stop();
  });
  app.addHook("onClose", async () => {
    await f.scheduler.stop();
    closeDB();
  });
  const signals = new EventEmitter();
  const finish = vi.fn();
  const controller = installShutdown(app, logger, 10000, finish, signals);
  return { ...f, task, app, closeDB, signals, finish, controller };
}

test.each(["SIGTERM", "SIGINT"])(
  "C1-11/14/17 %s existing Fastify lifecycle waits then closes DB owner",
  async (signal) => {
    const f = lifecycle();
    await f.app.ready();
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signals.listenerCount("SIGTERM")).toBe(1);
    expect(f.signals.listenerCount("SIGINT")).toBe(1);
    f.signals.emit(signal);
    const stopped = f.controller.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    for (const key of STATE_KEYS) f.scheduler.requestRecheck(key);
    expect(f.closeDB).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
    f.task.resolve(scheduled());
    await stopped;
    expect(f.closeDB).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.runOnce).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("C1-15 existing overall deadline ends at 10 seconds without an additional Scheduler allowance", async () => {
  const f = lifecycle();
  await f.app.ready();
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  f.signals.emit("SIGTERM");
  const stopped = f.controller.shutdown();
  await vi.advanceTimersByTimeAsync(9999);
  expect(f.finish).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await stopped;
  expect(f.finish).toHaveBeenCalledExactlyOnceWith(1);
  expect(f.closeDB).not.toHaveBeenCalled();
  f.task.resolve(scheduled());
  await f.app.close();
  expect(f.finish).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("an active callback is consumed once even when invoked twice", async () => {
  const task = deferred<RunOnceResult>();
  const spy = vi.spyOn(globalThis, "setTimeout");
  const f = fixture(async () => task.promise);
  f.scheduler.start();
  const callback = spy.mock.calls[4][0] as () => void;
  callback();
  callback();
  await Promise.resolve();
  expect(callsFor(f, "schedule")).toBe(1);
  const stopped = f.scheduler.stop();
  task.resolve(scheduled());
  await stopped;
});

test("an invalid actual clock cannot produce a reservation", async () => {
  const f = fixture(async () => ({
    kind: "scheduled",
    recheckAt: "2030-01-01T00:01:00Z",
  }));
  f.scheduler.start();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.logger.warn).toHaveBeenCalledTimes(5);
  clock.mockRestore();
  await f.scheduler.stop();
});

// ---- Issue #108: 60-second wait slices (F1) and past/current recheckAt (F2) ----
const iso = (ms: number) => new Date(ms).toISOString();
const deferredWarns = (f: ReturnType<typeof fixture>) =>
  f.logger.warn.mock.calls.filter(
    ([fields]) =>
      (fields as { event?: string }).event === "scheduler_recheck_deferred",
  );
/** A Coordinator stand-in that, like the real one, only "acquires" once the
 * wall clock reaches nextAttemptAt and otherwise returns it as recheckAt.
 */
function untilDue(nextAttemptAt: number, periodMs = 600_000) {
  const acquiredAt: number[] = [];
  let next = nextAttemptAt;
  const f = fixture(async (key) => {
    if (key !== "weeklyWeather") return scheduled(10 * 60_000);
    const now = Date.now();
    if (now < next) return { kind: "scheduled", recheckAt: iso(next) };
    acquiredAt.push(now);
    next = now + periodMs;
    return { kind: "scheduled", recheckAt: iso(next) };
  });
  const evaluations = () => callsFor(f, "weeklyWeather");
  return { ...f, acquiredAt, evaluations };
}

describe("Issue #108 F1: a single wait is at most 60 seconds", () => {
  test("a recheckAt within 60 seconds is reserved as is", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const f = fixture(async () => scheduled(30_000));
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(spy.mock.calls.slice(-5).map(([, delay]) => delay)).toEqual(
      Array(5).fill(30_000),
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.runOnce).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.runOnce).toHaveBeenCalledTimes(10);
    await f.scheduler.stop();
  });

  test("a longer wait starts with 60 seconds and repeats until due without clock change", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const f = untilDue(epoch + 5 * 60_000);
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(spy.mock.calls.at(-1)![1]).toBe(RECHECK_INTERVAL_MS);
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);
      expect(f.evaluations()).toBe(i + 1);
      expect(f.acquiredAt).toEqual([]);
    }
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);
    expect(f.acquiredAt).toEqual([epoch + 5 * 60_000]);
    await f.scheduler.stop();
  });

  test("a forward clock jump during a long wait is re-evaluated within 60 seconds", async () => {
    // Booted with a clock one day behind; the saved nextAttemptAt is 6 hours ahead.
    const f = untilDue(epoch + 6 * 3_600_000);
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.setSystemTime(Date.now() + 86_400_000); // NTP correction
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS - 10_001);
    expect(f.acquiredAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.acquiredAt).toHaveLength(1);
    expect(deferredWarns(f)).toEqual([]);
    await f.scheduler.stop();
  });

  test("a backward clock jump does not acquire before nextAttemptAt", async () => {
    const f = untilDue(epoch + 2 * 60_000);
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f.acquiredAt).toEqual([]); // the wall clock is still before it
    expect(f.evaluations()).toBeGreaterThan(60);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(f.acquiredAt).toEqual([epoch + 2 * 60_000]);
    await f.scheduler.stop();
  });

  test("States keep independent 60-second slices", async () => {
    const f = fixture(async (key) =>
      key === "schedule" ? scheduled(20_000) : scheduled(3_600_000),
    );
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);
    expect(callsFor(f, "schedule")).toBe(4); // 0, 20, 40, 60 s
    expect(callsFor(f, "weeklyWeather")).toBe(2); // 0, 60 s
    expect(vi.getTimerCount()).toBe(5);
    await f.scheduler.stop();
  });

  test("an old slice callback after requestRecheck cannot run a second Task", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const f = fixture(async () => scheduled(3_600_000));
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    const last = STATE_KEYS.at(-1)!; // the last reservation belongs to it
    const old = spy.mock.calls.at(-1)![0] as () => void;
    f.scheduler.requestRecheck(last);
    await vi.advanceTimersByTimeAsync(0);
    old();
    await Promise.resolve();
    expect(callsFor(f, last)).toBe(2);
    expect(vi.getTimerCount()).toBe(5);
    await f.scheduler.stop();
  });
});

describe("Issue #108 F2: a valid past/current recheckAt is deferred, not held", () => {
  test.each([
    ["current", 0],
    ["past", -1000],
    ["far past", -86_400_000],
  ])(
    "%s recheckAt is re-evaluated after 60 seconds, not at once",
    async (_, offset) => {
      const f = fixture(async (key) =>
        key === "schedule"
          ? { kind: "scheduled", recheckAt: iso(Date.now() + offset) }
          : scheduled(3_600_000),
      );
      f.scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(5);
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS - 1);
      expect(callsFor(f, "schedule")).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(callsFor(f, "schedule")).toBe(2);
      expect(f.logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "scheduler_held" }),
        expect.any(String),
      );
      await f.scheduler.stop();
    },
  );

  test("clock moving forward between the Coordinator result and reservation (race)", async () => {
    const f = fixture(async (key) => {
      if (key !== "schedule") return scheduled(3_600_000);
      const result = scheduled(1000); // Coordinator: now + 1 s
      // NTP steps the clock after the result is built, before validation.
      queueMicrotask(() => vi.setSystemTime(Date.now() + 480_000));
      return result;
    });
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(5); // the State keeps a timer
    expect(deferredWarns(f)).toHaveLength(1);
    f.runOnce.mockImplementation(async () => scheduled(3_600_000));
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);
    expect(callsFor(f, "schedule")).toBe(2);
    await f.scheduler.stop();
  });

  test("the warning is logged once while repeated, again after a future recheckAt, without values", async () => {
    let past = true;
    const values: string[] = [];
    const f = fixture(async (key) => {
      if (key !== "schedule") return scheduled(3_600_000);
      const recheckAt = past ? iso(Date.now() - 5000) : iso(Date.now() + 1000);
      values.push(recheckAt);
      return { kind: "scheduled", recheckAt };
    });
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3 * RECHECK_INTERVAL_MS);
    expect(callsFor(f, "schedule")).toBe(4);
    expect(deferredWarns(f)).toEqual([
      [
        {
          event: "scheduler_recheck_deferred",
          stateKey: "schedule",
          reason: "recheck_at_not_future",
        },
        expect.any(String),
      ],
    ]);
    past = false;
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS); // future accepted
    past = true;
    await vi.advanceTimersByTimeAsync(1000); // past again
    expect(deferredWarns(f)).toHaveLength(2);
    const logged = JSON.stringify(f.logger.warn.mock.calls);
    for (const value of values) expect(logged).not.toContain(value);
    await f.scheduler.stop();
  });

  test("one State's deferral does not affect another State", async () => {
    const f = fixture(async (key) =>
      key === "schedule"
        ? { kind: "scheduled", recheckAt: iso(Date.now() - 1) }
        : scheduled(10_000),
    );
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);
    expect(callsFor(f, "schedule")).toBe(2);
    expect(callsFor(f, "currentWeather")).toBe(7); // 0, 10 … 60 s
    expect(vi.getTimerCount()).toBe(5);
    await f.scheduler.stop();
  });

  test("a broken logger does not stop the deferred re-evaluation", async () => {
    const f = fixture(async (key) =>
      key === "schedule"
        ? { kind: "scheduled", recheckAt: iso(Date.now()) }
        : scheduled(3_600_000),
    );
    f.logger.warn.mockImplementation(() => {
      throw new Error("broken logger");
    });
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(5);
    await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);
    expect(callsFor(f, "schedule")).toBe(2);
    await f.scheduler.stop();
  });

  test("a deferred re-evaluation is not rearmed after stop", async () => {
    const f = fixture(async () => ({
      kind: "scheduled",
      recheckAt: iso(Date.now()),
    }));
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await f.scheduler.stop();
    await vi.advanceTimersByTimeAsync(3 * RECHECK_INTERVAL_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.runOnce).toHaveBeenCalledTimes(5);
  });
});
