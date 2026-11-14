import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimeAvailability } from "../../src/frontend/clock/availability";
import {
  TIME_AVAILABILITY_EXPIRY_MS,
  TIME_POLLING_INTERVAL_MS,
  TIME_POLLING_TIMEOUT_MS,
  createTimeAvailabilityExpiry,
  parseTimeAvailability,
  startTimeAvailability,
  type TimeAvailabilityRuntime,
} from "../../src/frontend/clock/time-availability-polling";

// 表示用時刻の利用可否の取得（docs/frontend-development.md 第13章、technology-stack 25.4）。

describe("parseTimeAvailability", () => {
  it("accepts only the two values without other keys", () => {
    expect(parseTimeAvailability({ availability: "available" })).toBe(
      "available",
    );
    expect(parseTimeAvailability({ availability: "unavailable" })).toBe(
      "unavailable",
    );
    for (const value of [
      null,
      "available",
      {},
      { availability: "yes" },
      { availability: true },
      { availability: "available", reason: "ntp" },
    ])
      expect(parseTimeAvailability(value)).toBeNull();
  });
});

describe("startTimeAvailability", () => {
  let fetch: ReturnType<typeof vi.fn<TimeAvailabilityRuntime["fetch"]>>;
  let changes: TimeAvailability[];
  let stop: (() => void) | undefined;
  const runtime = (): TimeAvailabilityRuntime => ({
    fetch,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(), // Fake Timerで進む単調時計の代わり
  });
  const reply = (body: unknown, status = 200) =>
    Promise.resolve(Response.json(body, { status }));
  const available = () => reply({ availability: "available" });
  const unavailable = () => reply({ availability: "unavailable" });
  const fail = () => Promise.reject(new TypeError("network"));
  const begin = () => {
    stop = startTimeAvailability((v) => changes.push(v), runtime());
  };
  const last = () => changes.at(-1) ?? "unavailable";

  beforeEach(() => {
    vi.useFakeTimers();
    fetch = vi.fn<TimeAvailabilityRuntime["fetch"]>();
    changes = [];
  });
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it("starts unavailable and shows the received value", async () => {
    let release!: (r: Response) => void;
    fetch.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toBe("unavailable");
    release(Response.json({ availability: "available" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual(["available"]);
    expect(fetch.mock.calls[0]![0]).toBe("/api/time-availability");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
  });

  it("requests at once, then 10 s after each completion", async () => {
    fetch.mockImplementation(available);
    begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(TIME_POLLING_INTERVAL_MS - 1);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("one request at a time; a 3 s timeout fails it and ignores a late reply", async () => {
    fetch.mockImplementationOnce(() => new Promise<Response>(() => {}));
    fetch.mockImplementation(available);
    begin();
    await vi.advanceTimersByTimeAsync(TIME_POLLING_TIMEOUT_MS - 1);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(last()).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(TIME_POLLING_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(last()).toBe("available");
  });

  it("applies a received unavailable at once", async () => {
    fetch.mockImplementationOnce(available).mockImplementation(unavailable);
    begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toBe("available");
    await vi.advanceTimersByTimeAsync(TIME_POLLING_INTERVAL_MS);
    expect(changes).toEqual(["available", "unavailable"]);
  });

  it("keeps the last value on failures, then expires 60 s after the last success", async () => {
    fetch.mockImplementationOnce(available).mockImplementation(fail);
    begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toBe("available");
    await vi.advanceTimersByTimeAsync(TIME_AVAILABILITY_EXPIRY_MS - 1);
    expect(fetch.mock.calls.length).toBeGreaterThan(3); // failures do not extend
    expect(last()).toBe("available");
    await vi.advanceTimersByTimeAsync(1);
    expect(changes).toEqual(["available", "unavailable"]);
  });

  it("a success in between moves the deadline", async () => {
    fetch
      .mockImplementationOnce(available)
      .mockImplementationOnce(fail)
      .mockImplementationOnce(available) // at 20 s
      .mockImplementation(fail);
    begin();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(TIME_POLLING_INTERVAL_MS * 2);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(TIME_AVAILABILITY_EXPIRY_MS - 1);
    expect(last()).toBe("available");
    await vi.advanceTimersByTimeAsync(1);
    expect(last()).toBe("unavailable");
  });

  it.each([
    ["503", () => reply({ error: "x" }, 503)],
    ["invalid body", () => reply({ availability: "maybe" })],
    ["unknown key", () => reply({ availability: "available", extra: 1 })],
    ["not JSON", () => Promise.resolve(new Response("<html>"))],
  ])("treats %s as a failure", async (_name, bad) => {
    fetch.mockImplementationOnce(available).mockImplementation(bad);
    begin();
    await vi.advanceTimersByTimeAsync(TIME_POLLING_INTERVAL_MS * 2);
    expect(changes).toEqual(["available"]);
    await vi.advanceTimersByTimeAsync(TIME_AVAILABILITY_EXPIRY_MS);
    expect(changes).toEqual(["available", "unavailable"]);
  });

  it("never-received stays unavailable without changes", async () => {
    fetch.mockImplementation(fail);
    begin();
    await vi.advanceTimersByTimeAsync(TIME_AVAILABILITY_EXPIRY_MS * 2);
    expect(changes).toEqual([]);
  });

  it("stops requests and timers on unmount; nothing changes afterwards", async () => {
    fetch.mockImplementationOnce(available).mockImplementation(fail);
    begin();
    await vi.advanceTimersByTimeAsync(0);
    stop!();
    stop = undefined;
    await vi.advanceTimersByTimeAsync(TIME_AVAILABILITY_EXPIRY_MS * 2);
    expect(fetch).toHaveBeenCalledOnce();
    expect(changes).toEqual(["available"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an in-flight request on unmount and ignores its reply", async () => {
    let release!: (r: Response) => void;
    fetch.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    begin();
    await vi.advanceTimersByTimeAsync(0);
    stop!();
    stop = undefined;
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    release(Response.json({ availability: "available" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toEqual([]);
  });
});

describe("createTimeAvailabilityExpiry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("measures 60 s with the monotonic clock even if the timer fires early", () => {
    let mono = 0;
    const timers: { cb: () => void; ms: number }[] = [];
    const changes: TimeAvailability[] = [];
    const expiry = createTimeAvailabilityExpiry((v) => changes.push(v), {
      setTimeout: (cb, ms) => timers.push({ cb, ms }),
      clearTimeout: () => {},
      now: () => mono,
    });
    expiry.result("available");
    expect(timers.at(-1)!.ms).toBe(TIME_AVAILABILITY_EXPIRY_MS);
    mono = 30_000;
    timers.at(-1)!.cb(); // fired early: reschedules the rest
    expect(changes).toEqual(["available"]);
    expect(timers.at(-1)!.ms).toBe(30_000);
    mono = 60_000;
    timers.at(-1)!.cb();
    expect(changes).toEqual(["available", "unavailable"]);
  });

  it("ignores results after dispose", () => {
    const changes: TimeAvailability[] = [];
    const expiry = createTimeAvailabilityExpiry((v) => changes.push(v), {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    });
    expiry.dispose();
    expiry.result("available");
    expect(changes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
