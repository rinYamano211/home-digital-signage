import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POLLING_INTERVAL_MS,
  POLLING_TIMEOUT_MS,
  startPolling,
  type PollingRuntime,
  type PollingSnapshot,
} from "../../src/frontend/published-state/polling";
import { parsePublishedStates } from "../../src/frontend/published-state/schema";

// 表示用APIのResponseの検証とPolling（docs/frontend-development.md 11.3、technology-stack 7.3）。

const meta = (over = {}) => ({
  dataUpdatedAt: "2026-11-08T00:00:00Z",
  expiresAt: "2026-11-08T06:00:00Z",
  lastAttemptAt: "2026-11-08T00:00:00Z",
  lastAttemptResult: "success",
  publishedAt: "2026-11-08T00:00:00Z",
  dataSource: "externalApi",
  ...over,
});
const schedule = (data: unknown = { date: "2026-11-08", events: [] }) => ({
  data,
  meta: meta(),
});
const weather = { data: { anything: 1 }, meta: meta() };

describe("parsePublishedStates", () => {
  it("keeps valid States and ignores unknown keys", () => {
    expect(
      parsePublishedStates({
        schemaVersion: 1,
        states: { schedule: schedule(), currentWeather: weather, extra: 1 },
      }),
    ).toEqual({ schedule: schedule(), currentWeather: weather });
  });

  it.each([
    null,
    [],
    { states: {} },
    { schemaVersion: 2, states: {} },
    { schemaVersion: 1 },
    { schemaVersion: 1, states: [] },
  ])("an invalid envelope is a Polling failure: %j", (value) => {
    expect(parsePublishedStates(value)).toBeNull();
  });

  it.each([
    ["missing meta", { data: null }],
    ["extra key", { ...schedule(), x: 1 }],
    ["data null with dataSource", { data: null, meta: meta() }],
    [
      "data without dataSource",
      {
        data: { date: "2026-11-08", events: [] },
        meta: meta({ dataSource: null }),
      },
    ],
    [
      "attempt pair broken",
      { ...schedule(), meta: meta({ lastAttemptResult: null }) },
    ],
    ["success pair broken", { ...schedule(), meta: meta({ expiresAt: null }) }],
    ["bad instant", { ...schedule(), meta: meta({ publishedAt: "later" }) }],
    ["schedule domain: events missing", schedule({ date: "2026-11-08" })],
    [
      "schedule domain: duplicate id",
      schedule({
        date: "2026-11-08",
        events: [
          {
            id: "a",
            title: "",
            allDay: true,
            startDate: "2026-11-08",
            endDateExclusive: "2026-11-09",
          },
          {
            id: "a",
            title: "",
            allDay: true,
            startDate: "2026-11-08",
            endDateExclusive: "2026-11-09",
          },
        ],
      }),
    ],
    [
      "schedule domain: end before start",
      schedule({
        date: "2026-11-08",
        events: [
          {
            id: "a",
            title: "",
            allDay: false,
            startAt: "2026-11-08T02:00:00Z",
            endAt: "2026-11-08T01:00:00Z",
          },
        ],
      }),
    ],
  ])("only the State failing validation is excluded: %s", (_name, bad) => {
    expect(
      parsePublishedStates({
        schemaVersion: 1,
        states: { schedule: bad, currentWeather: weather },
      }),
    ).toEqual({ currentWeather: weather });
  });
});

describe("startPolling", () => {
  let fetch: ReturnType<typeof vi.fn<PollingRuntime["fetch"]>>;
  let snapshots: PollingSnapshot[];
  let stop: (() => void) | undefined;
  const runtime = (): PollingRuntime => ({
    fetch,
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const ok = (states: unknown) =>
    Promise.resolve(Response.json({ schemaVersion: 1, states }));
  const begin = () => {
    stop = startPolling((s) => snapshots.push(s), runtime());
  };

  beforeEach(() => {
    vi.useFakeTimers();
    fetch = vi.fn<PollingRuntime["fetch"]>();
    snapshots = [];
  });
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it("requests at once, then 30 s after each completion, one at a time", async () => {
    fetch.mockImplementation(() => ok({ schedule: schedule() }));
    begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe("/api/published-states");
    expect(snapshots.at(-1)).toMatchObject({
      status: "received",
      states: { schedule: schedule() },
    });
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS - 1);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("the interval starts after a slow request completes (no overlap)", async () => {
    let release!: (r: Response) => void;
    fetch.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    fetch.mockImplementation(() => ok({}));
    begin();
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetch).toHaveBeenCalledOnce();
    release(Response.json({ schemaVersion: 1, states: {} }));
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS - 1);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a request is aborted after 5 s and counts as a failure", async () => {
    fetch.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    );
    begin();
    await vi.advanceTimersByTimeAsync(POLLING_TIMEOUT_MS - 1);
    expect(snapshots).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshots).toEqual([
      { status: "neverReceived", states: {}, at: expect.any(Number) },
    ]);
  });

  it("an HTTP failure keeps the last good states; a success replaces them all", async () => {
    fetch
      .mockImplementationOnce(() =>
        ok({ schedule: schedule(), currentWeather: weather }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          Response.json({ error: "database_unavailable" }, { status: 503 }),
        ),
      )
      .mockImplementationOnce(() => Promise.reject(new TypeError("offline")))
      .mockImplementationOnce(() => Promise.resolve(new Response("{")))
      .mockImplementationOnce(() => ok({ currentWeather: weather }));
    begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(4);
    // Failures after a success do not notify and do not drop the held states.
    expect(snapshots).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(snapshots.at(-1)).toMatchObject({
      status: "received",
      states: { currentWeather: weather },
    });
    expect(snapshots.at(-1)!.states).not.toHaveProperty("schedule");
  });

  it("stop() cancels the timer and the in-flight request", async () => {
    let signal: AbortSignal | undefined;
    fetch.mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    });
    begin();
    await vi.advanceTimersByTimeAsync(0);
    stop!();
    stop = undefined;
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS * 2);
    expect(fetch).toHaveBeenCalledOnce();
    expect(snapshots).toEqual([]);
  });
});
