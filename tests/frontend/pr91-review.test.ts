import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fitSchedule } from "../../src/frontend/schedule/fit";
import { scheduleList } from "../../src/frontend/schedule/schedule-state";
import {
  POLLING_INTERVAL_MS,
  POLLING_TIMEOUT_MS,
  startPolling,
  type PollingRuntime,
  type PollingSnapshot,
} from "../../src/frontend/published-state/polling";
import { parsePublishedStates } from "../../src/frontend/published-state/schema";
import {
  scheduleInstant,
  utcInstant,
} from "../../src/frontend/published-state/utc-instant";
import { validScheduleShape } from "../../src/frontend/schedule/schedule-data";

// PR #91のレビュー指摘への回帰テスト：進行中の省略、日時の検証、Pollingの論理Timeout。

const jst = (s: string) => Date.parse(`${s}+09:00`);
const NOW = jst("2026-11-08T12:00:00");
const iso = (ms: number) => new Date(ms).toISOString();

describe("ongoing events are never hidden by the overflow (UI 5.1)", () => {
  const ongoing = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `o${i}`,
      title: `進行中${i}`,
      allDay: false as const,
      startAt: iso(jst("2026-11-08T11:00:00") + i * 60_000),
      endAt: iso(jst("2026-11-08T14:00:00")),
    }));
  const upcoming = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `u${String(i).padStart(2, "0")}`,
      title: `予定${i}`,
      allDay: false as const,
      startAt: iso(jst("2026-11-08T15:00:00") + i * 600_000),
      endAt: iso(jst("2026-11-08T15:05:00") + i * 600_000),
    }));
  const data = (events: unknown[]) =>
    ({ date: "2026-11-08", events }) as Parameters<typeof scheduleList>[0];

  it("hides only events after the next one; the 3rd+ ongoing stay", () => {
    const list = scheduleList(data([...ongoing(4), ...upcoming(20)]), NOW);
    expect(list.later.slice(0, 2).map((r) => r.id)).toEqual(["o2", "o3"]);
    const fitted = fitSchedule(list, false);
    expect(fitted.ongoing.map((r) => r.id)).toEqual(["o0", "o1"]);
    expect(fitted.next?.id).toBe("u00");
    expect(fitted.later.slice(0, 2).map((r) => r.id)).toEqual(["o2", "o3"]);
    expect(fitted.hidden).toBeGreaterThan(0);
    expect(fitted.later.length + fitted.hidden).toBe(list.later.length);
  });

  it("with too many ongoing events, every ongoing and the next stay (overflow is clipped)", () => {
    const list = scheduleList(data([...ongoing(14), ...upcoming(5)]), NOW);
    const fitted = fitSchedule(list, true);
    expect(fitted.ongoing).toHaveLength(2);
    expect(fitted.next?.id).toBe("u00");
    expect(fitted.later.filter((r) => r.phase === "ongoing")).toHaveLength(12);
    expect(fitted.later.filter((r) => r.phase === "upcoming")).toEqual([]);
    expect(fitted.hidden).toBe(4);
  });
});

describe("date-time validation matches the Backend API contract", () => {
  it.each([
    "2026-11-08T00:00:00Z",
    "2026-11-08T00:00:00.000Z",
    "2026-11-08T00:00:00+00:00",
    "2024-02-29T23:59:59.999Z",
  ])("accepts UTC %s", (value) => {
    expect(utcInstant(value)).not.toBeNull();
  });

  it.each([
    "2026-11-08T09:00:00+09:00",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-11-08T24:00:00Z",
    "2026-11-08T23:60:00Z",
    "2026-11-08T23:59:60Z",
    "2026-11-08 00:00:00Z",
    "Sun, 08 Nov 2026 00:00:00 GMT",
    "2026-11-08",
    "1794096000000",
  ])("rejects %s", (value) => {
    expect(utcInstant(value)).toBeNull();
  });

  it("schedule start / end must be the Backend toISOString form", () => {
    expect(scheduleInstant("2026-11-08T00:00:00.000Z")).not.toBeNull();
    expect(scheduleInstant("2026-11-08T00:00:00Z")).toBeNull();
    expect(scheduleInstant("2026-11-08T00:00:00+00:00")).toBeNull();
  });

  const event = (over: Record<string, unknown>) => ({
    date: "2026-11-08",
    events: [
      {
        id: "a",
        title: "",
        allDay: false,
        startAt: "2026-11-08T00:00:00.000Z",
        endAt: "2026-11-08T01:00:00.000Z",
        ...over,
      },
    ],
  });
  it.each([
    ["offset", { startAt: "2026-11-08T09:00:00.000+09:00" }],
    ["non-existent", { startAt: "2026-02-30T00:00:00.000Z" }],
    ["hour out of range", { endAt: "2026-11-08T24:00:00.000Z" }],
    ["start equals end", { endAt: "2026-11-08T00:00:00.000Z" }],
    ["start after end", { startAt: "2026-11-08T02:00:00.000Z" }],
    ["no milliseconds", { startAt: "2026-11-08T00:00:00Z" }],
  ])("a schedule with an invalid time is rejected: %s", (_n, over) => {
    expect(validScheduleShape(event(over))).toBe(false);
  });

  it("rejects non-existent dates; keeps a valid Backend Response", () => {
    expect(validScheduleShape(event({}))).toBe(true);
    expect(validScheduleShape({ date: "2026-02-30", events: [] })).toBe(false);
    expect(
      validScheduleShape({
        date: "2026-11-08",
        events: [
          {
            id: "d",
            title: "",
            allDay: true,
            startDate: "2026-11-08",
            endDateExclusive: "2026-11-31",
          },
        ],
      }),
    ).toBe(false);
  });

  const meta = {
    dataUpdatedAt: "2026-11-08T00:00:00.000Z",
    expiresAt: "2026-11-08T06:00:00.000Z",
    lastAttemptAt: "2026-11-08T00:00:00.000Z",
    lastAttemptResult: "success",
    publishedAt: "2026-11-08T00:00:00.000Z",
    dataSource: "externalApi",
  };
  it("Metadata with a non-UTC or non-existent instant excludes only that State", () => {
    const ok = { data: { x: 1 }, meta };
    for (const bad of [
      { ...meta, publishedAt: "2026-11-08T09:00:00+09:00" },
      { ...meta, expiresAt: "2026-02-30T00:00:00Z" },
      { ...meta, dataUpdatedAt: "yesterday" },
    ])
      expect(
        parsePublishedStates({
          schemaVersion: 1,
          states: {
            currentWeather: { data: { x: 1 }, meta: bad },
            weeklyWeather: ok,
          },
        }),
      ).toEqual({ weeklyWeather: ok });
  });
});

describe("Polling continues after the 5 s timeout even if fetch never settles", () => {
  let fetch: ReturnType<typeof vi.fn<PollingRuntime["fetch"]>>;
  let snapshots: PollingSnapshot[];
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    fetch = vi.fn<PollingRuntime["fetch"]>();
    snapshots = [];
  });
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });
  const begin = () => {
    stop = startPolling((s) => snapshots.push(s), {
      fetch,
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
  };

  it("an aborted request that never settles still ends at 5 s; the next poll runs 30 s later", async () => {
    let signal: AbortSignal | undefined;
    let lateResolve!: (r: Response) => void;
    fetch.mockImplementationOnce((_input, init) => {
      signal = init?.signal ?? undefined;
      // Ignores the abort and never settles until released.
      return new Promise<Response>((resolve) => (lateResolve = resolve));
    });
    fetch.mockImplementation(() =>
      Promise.resolve(Response.json({ schemaVersion: 1, states: {} })),
    );
    begin();
    await vi.advanceTimersByTimeAsync(POLLING_TIMEOUT_MS);
    expect(signal?.aborted).toBe(true);
    expect(snapshots).toEqual([
      { status: "neverReceived", states: {}, at: expect.any(Number) },
    ]);
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)).toMatchObject({ status: "received", states: {} });
    // A late response from the timed-out request is never adopted.
    const before = snapshots.length;
    lateResolve(
      Response.json({
        schemaVersion: 1,
        states: {
          currentWeather: {
            data: { late: true },
            meta: {
              dataUpdatedAt: "2026-11-08T00:00:00Z",
              expiresAt: "2026-11-08T06:00:00Z",
              lastAttemptAt: "2026-11-08T00:00:00Z",
              lastAttemptResult: "success",
              publishedAt: "2026-11-08T00:00:00Z",
              dataSource: "externalApi",
            },
          },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).toHaveLength(before);
    expect(snapshots.at(-1)!.states).toEqual({});
  });

  it("a body that never finishes after the headers also times out", async () => {
    fetch.mockImplementationOnce(() =>
      Promise.resolve(new Response(new ReadableStream({ start() {} }))),
    );
    fetch.mockImplementation(() =>
      Promise.resolve(Response.json({ schemaVersion: 1, states: {} })),
    );
    begin();
    await vi.advanceTimersByTimeAsync(POLLING_TIMEOUT_MS);
    expect(snapshots.at(-1)?.status).toBe("neverReceived");
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    expect(snapshots.at(-1)?.status).toBe("received");
  });
});
