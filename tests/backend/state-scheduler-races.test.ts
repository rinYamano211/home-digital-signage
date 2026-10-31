import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  StateScheduler,
  type RunOnceResult,
} from "../../src/backend/scheduler/state-scheduler.js";
import type { StateKey } from "../../src/backend/storage/published-state-repository.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const scheduled = (delay: number): RunOnceResult => ({
  kind: "scheduled",
  recheckAt: new Date(Date.now() + delay).toISOString(),
});
function setup() {
  const task = deferred<RunOnceResult>();
  let scheduleCalls = 0;
  const runOnce = vi.fn((key: StateKey): Promise<RunOnceResult> => {
    if (key !== "schedule") return Promise.resolve(scheduled(100000));
    scheduleCalls++;
    return scheduleCalls === 1
      ? task.promise
      : Promise.resolve(scheduled(50000));
  });
  const scheduler = new StateScheduler(
    { runOnce },
    { warn: vi.fn(), error: vi.fn() },
  );
  return { task, scheduler, calls: () => scheduleCalls, runOnce };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2030-01-01T00:00:00Z");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// These hooks enqueue microtasks; they do NOT invoke Timer callbacks inside
// setTimeout, which would fabricate a synchronous runtime Node does not provide.
test.each(["before-resolution", "after-resolution", "after-reservation"])(
  "R42-01 rechecks at %s coalesce and retain the following Timer",
  async (boundary) => {
    const f = setup();
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    let requests = 0;
    const request = () => {
      requests++;
      for (let i = 0; i < 20; i++) f.scheduler.requestRecheck("schedule");
    };
    const timer = globalThis.setTimeout;
    if (boundary === "after-reservation") {
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void,
        delay?: number,
      ) => {
        const handle = timer(callback, delay);
        if (delay === 10000) queueMicrotask(request);
        return handle;
      }) as typeof setTimeout);
    }
    if (boundary === "before-resolution") queueMicrotask(request);
    f.task.resolve(scheduled(10000));
    if (boundary === "after-resolution") queueMicrotask(request);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(requests).toBe(1);
      expect(f.calls()).toBe(2);
      expect(vi.getTimerCount()).toBe(5);
      await vi.advanceTimersByTimeAsync(50000);
      expect(f.calls()).toBe(3); // Next reservation was not lost.
      expect(vi.getTimerCount()).toBe(5);
    } finally {
      await f.scheduler.stop();
    }
  },
);

test("R42-02 coalesced 0ms reevaluation then earliest 1ms Timer both survive completion", async () => {
  const f = setup();
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  f.runOnce.mockImplementation((key) => {
    if (key !== "schedule") return Promise.resolve(scheduled(100000));
    return Promise.resolve(scheduled(1));
  });
  for (let i = 0; i < 10; i++) f.scheduler.requestRecheck("schedule");
  f.task.resolve(scheduled(10000));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(
      f.runOnce.mock.calls.filter(([key]) => key === "schedule"),
    ).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      f.runOnce.mock.calls.filter(([key]) => key === "schedule"),
    ).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(5);
  } finally {
    await f.scheduler.stop();
  }
});

test.each(["before-resolution", "after-reservation"])(
  "R42-03 stop at %s wins over completion and cancels queued rechecks",
  async (boundary) => {
    const f = setup();
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    f.scheduler.requestRecheck("schedule");
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping = f.scheduler.stop();
    };
    if (boundary === "before-resolution") stop();
    else {
      const timer = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void,
        delay?: number,
      ) => {
        const handle = timer(callback, delay);
        if (delay === 0) queueMicrotask(stop);
        return handle;
      }) as typeof setTimeout);
    }
    f.task.resolve(scheduled(10000));
    try {
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopping).toBeDefined();
      f.scheduler.requestRecheck("schedule");
      await vi.advanceTimersByTimeAsync(100000);
      expect(f.calls()).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.scheduler.stop();
    }
  },
);

test("R42-04 old callback after completion cannot consume a replacement Timer", async () => {
  const f = setup();
  const spy = vi.spyOn(globalThis, "setTimeout");
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  f.task.resolve(scheduled(10000));
  await vi.advanceTimersByTimeAsync(0);
  const old = spy.mock.calls.at(-1)![0] as () => void;
  f.scheduler.requestRecheck("schedule");
  old(); // Already queued callback from the canceled reservation.
  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls()).toBe(2);
    expect(vi.getTimerCount()).toBe(5);
    old();
    await vi.advanceTimersByTimeAsync(50000);
    expect(f.calls()).toBe(3);
    expect(vi.getTimerCount()).toBe(5);
  } finally {
    await f.scheduler.stop();
  }
});

test("R42-05 native Node Timer cannot preempt arm/finally even after its deadline elapses", async () => {
  vi.useRealTimers();
  const nativeTimeout = globalThis.setTimeout;
  const done = deferred<void>();
  const again = deferred<void>();
  let calls = 0;
  let registering = false;
  let observed = false;
  let preempted = false;
  const scheduler = new StateScheduler(
    {
      runOnce: (key) => {
        if (key !== "schedule") return Promise.resolve(scheduled(60000));
        calls++;
        if (calls < 20) queueMicrotask(() => scheduler.requestRecheck(key));
        else if (calls === 20) done.resolve();
        else if (calls === 21) again.resolve();
        return Promise.resolve(scheduled(60000));
      },
    },
    { warn: vi.fn(), error: vi.fn() },
  );
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    if (!observed && calls === 1 && delay === 0) {
      observed = true;
      registering = true;
      const handle = nativeTimeout(() => {
        preempted ||= registering;
        callback();
      }, delay);
      // Deliberately keep this synchronous stack busy past the 1ms Timer
      // threshold. Native setTimeout still cannot run its callback here.
      const until = performance.now() + 10;
      while (performance.now() < until) {
        /* Node JS run-to-completion */
      }
      registering = false;
      return handle;
    }
    return nativeTimeout(callback, delay);
  }) as typeof setTimeout);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    scheduler.start();
    await Promise.race([
      (async () => {
        await done.promise;
        // Drain the final Coordinator continuation, then use public recheck.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(observed).toBe(true);
        expect(preempted).toBe(false);
        expect(calls).toBe(20);
        scheduler.requestRecheck("schedule");
        await again.promise;
        expect(calls).toBe(21);
      })(),
      new Promise<never>((_, reject) => {
        deadline = nativeTimeout(
          () => reject(new Error("Native Scheduler stalled")),
          3000,
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
    await scheduler.stop();
  }
});
