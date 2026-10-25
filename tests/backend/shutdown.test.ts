import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { installShutdown } from "../../src/backend/shutdown.js";
import { createLogger } from "../../src/backend/logging/logger.js";

function setup(close: () => Promise<unknown>) {
  let logs = "";
  const logger = createLogger(
    "info",
    new Writable({
      write(chunk, _enc, cb) {
        logs += chunk;
        cb();
      },
    }),
  );
  const signals = new EventEmitter();
  const finish = vi.fn();
  const controller = installShutdown({ close }, logger, 10000, finish, signals);
  return { signals, finish, controller, logs: () => logs };
}
afterEach(() => vi.useRealTimers());

test.each(["SIGTERM", "SIGINT"])(
  "%s uses one shutdown and clears timer/listeners",
  async (signal) => {
    vi.useFakeTimers();
    const close = vi.fn().mockResolvedValue(undefined);
    const fixture = setup(close);
    fixture.signals.emit(signal);
    fixture.signals.emit("SIGTERM");
    fixture.signals.emit("SIGINT");
    const first = fixture.controller.shutdown();
    expect(fixture.controller.shutdown()).toBe(first);
    await first;
    expect(close).toHaveBeenCalledTimes(1);
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fixture.signals.listenerCount("SIGTERM")).toBe(0);
    expect(fixture.signals.listenerCount("SIGINT")).toBe(0);
    expect(fixture.logs()).toContain("shutdown_complete");
  },
);

test("10-second deadline fails once even if close later completes", async () => {
  vi.useFakeTimers();
  let resolveClose!: () => void;
  const fixture = setup(
    () =>
      new Promise<void>((resolve) => {
        resolveClose = resolve;
      }),
  );
  const pending = fixture.controller.shutdown();
  await vi.advanceTimersByTimeAsync(9999);
  expect(fixture.finish).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(1);
  resolveClose();
  await Promise.resolve();
  expect(fixture.finish).toHaveBeenCalledTimes(1);
  expect(fixture.logs()).toContain('"level":50');
  expect(fixture.logs()).toContain("shutdown_timeout");
  expect(vi.getTimerCount()).toBe(0);
});

test.each([true, false])(
  "close failure (sync=%s) is sanitized and clears deadline",
  async (sync) => {
    vi.useFakeTimers();
    const fixture = setup(() => {
      if (sync) throw new Error("secret-marker");
      return Promise.reject(new Error("secret-marker"));
    });
    await fixture.controller.shutdown();
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(1);
    expect(fixture.logs()).toContain("shutdown_failed");
    expect(fixture.logs()).not.toContain("secret-marker");
    expect(vi.getTimerCount()).toBe(0);
  },
);
