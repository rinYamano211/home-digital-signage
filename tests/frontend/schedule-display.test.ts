import { describe, expect, it } from "vitest";
import type { PublishedState } from "../../src/frontend/published-state/schema";
import type { ScheduleEvent } from "../../src/frontend/schedule/schedule-data";
import { fitSchedule } from "../../src/frontend/schedule/fit";
import {
  scheduleList,
  scheduleView,
  type ScheduleList,
  type TimedRow,
} from "../../src/frontend/schedule/schedule-state";
import { signageModel } from "../../src/frontend/signage-model";

// 予定のComponent State・並び順・表記・件数の集約・巡回への参加
// （docs/frontend-development.md 11.4〜11.6、UI設計 5.1・6.1・6.2・6.5）。描画は検証画面で目視する。

const jst = (s: string) => Date.parse(`${s}+09:00`);
const NOW = jst("2026-11-08T12:00:00");
const iso = (ms: number) => new Date(ms).toISOString();
const timed = (
  id: string,
  title: string,
  start: string,
  end: string,
): ScheduleEvent => ({
  id,
  title,
  allDay: false,
  startAt: iso(jst(start)),
  endAt: iso(jst(end)),
});
const allDay = (
  id: string,
  title: string,
  start: string,
  end: string,
): ScheduleEvent => ({
  id,
  title,
  allDay: true,
  startDate: start,
  endDateExclusive: end,
});
const state = (
  events: ScheduleEvent[] | null,
  meta: Partial<PublishedState["meta"]> = {},
  date = "2026-11-08",
): PublishedState => ({
  data: events === null ? null : { date, events },
  meta: {
    dataUpdatedAt: events === null ? null : iso(NOW - 600_000),
    expiresAt: events === null ? null : iso(NOW + 3_600_000),
    lastAttemptAt: iso(NOW - 600_000),
    lastAttemptResult: events === null ? "failure" : "success",
    publishedAt: iso(NOW - 600_000),
    dataSource: events === null ? null : "externalApi",
    ...meta,
  },
});

describe("scheduleView (11.4)", () => {
  it.each([
    ["no State, first response pending", undefined, "waiting", "loading"],
    ["no State (unpublished or invalid)", undefined, "received", "unavailable"],
    [
      "data null, never attempted",
      state(null, { lastAttemptAt: null, lastAttemptResult: null }),
      "received",
      "loading",
    ],
    ["data null after an attempt", state(null), "received", "unavailable"],
    ["expired", state([], { expiresAt: iso(NOW) }), "received", "unavailable"],
    ["another day", state([], {}, "2026-11-07"), "received", "unavailable"],
    ["valid and empty", state([]), "received", "empty"],
  ] as const)("%s → %s", (_n, s, polling, kind) => {
    expect(scheduleView(s, polling, NOW).kind).toBe(kind);
  });

  it("valid events give a list; the stale badge follows lastAttemptResult, not dataSource", () => {
    const events = [
      timed("a", "A", "2026-11-08T13:00:00", "2026-11-08T14:00:00"),
    ];
    expect(scheduleView(state(events), "received", NOW)).toMatchObject({
      kind: "list",
      stale: null,
    });
    expect(
      scheduleView(
        state(events, {
          lastAttemptResult: "failure",
          dataSource: "externalApi",
        }),
        "received",
        NOW,
      ),
    ).toMatchObject({ kind: "list", stale: { since: "11:50" } });
    expect(
      scheduleView(
        state([], {
          lastAttemptResult: "failure",
          dataUpdatedAt: iso(jst("2026-11-07T23:50:00")),
        }),
        "received",
        NOW,
      ),
    ).toEqual({ kind: "empty", stale: { since: "11/7 23:50" } });
  });
});

const rowsOf = (list: ScheduleList) => ({
  ended: list.ended.map((r) => r.id),
  ongoing: list.ongoing.map((r) => r.id),
  next: list.next?.id ?? null,
  later: list.later.map((r) => r.id),
});
const data = (events: ScheduleEvent[]) => ({ date: "2026-11-08", events });

describe("scheduleList (11.5, UI 5.1)", () => {
  it("splits ended / ongoing (max 2 big) / next / later", () => {
    const list = scheduleList(
      data([
        timed("e", "ended", "2026-11-08T08:00:00", "2026-11-08T09:00:00"),
        timed("o1", "on1", "2026-11-08T11:00:00", "2026-11-08T13:00:00"),
        timed("o2", "on2", "2026-11-08T11:30:00", "2026-11-08T12:30:00"),
        timed("o3", "on3", "2026-11-08T11:45:00", "2026-11-08T12:15:00"),
        timed("n", "next", "2026-11-08T14:00:00", "2026-11-08T15:00:00"),
        timed("l", "later", "2026-11-08T16:00:00", "2026-11-08T17:00:00"),
      ]),
      NOW,
    );
    expect(rowsOf(list)).toEqual({
      ended: ["e"],
      ongoing: ["o1", "o2"],
      next: "n",
      later: ["o3", "l"],
    });
    // Ends exactly now → ended; starts exactly now → ongoing.
    const edge = scheduleList(
      data([
        timed("x", "", "2026-11-08T11:00:00", "2026-11-08T12:00:00"),
        timed("y", "", "2026-11-08T12:00:00", "2026-11-08T13:00:00"),
      ]),
      NOW,
    );
    expect(rowsOf(edge)).toMatchObject({ ended: ["x"], ongoing: ["y"] });
  });

  it("sorts by start then ID, independent of the API order (stable across polls)", () => {
    const events = [
      timed("b", "B", "2026-11-08T14:00:00", "2026-11-08T15:00:00"),
      timed("a", "A", "2026-11-08T14:00:00", "2026-11-08T15:00:00"),
      timed("c", "C", "2026-11-08T13:00:00", "2026-11-08T15:00:00"),
      allDay("z", "Z", "2026-11-08", "2026-11-09"),
      allDay("y", "Y", "2026-11-08", "2026-11-09"),
      allDay("w", "W", "2026-11-07", "2026-11-09"),
    ];
    const expected = { next: "c", later: ["a", "b"] };
    for (const order of [events, [...events].reverse()]) {
      const list = scheduleList(data(order), NOW);
      expect(rowsOf(list)).toMatchObject(expected);
      expect(list.allDay.map((c) => c.id)).toEqual(["w", "y", "z"]);
    }
  });

  const row = (event: ScheduleEvent): TimedRow =>
    scheduleList(data([event]), NOW).next ??
    scheduleList(data([event]), NOW).ongoing[0] ??
    scheduleList(data([event]), NOW).ended[0]!;

  it.each([
    [
      "normal",
      timed("a", "T", "2026-11-08T13:00:00", "2026-11-08T14:00:00"),
      "13:00",
      "",
    ],
    [
      "ends tomorrow",
      timed("a", "T", "2026-11-08T23:00:00", "2026-11-09T01:00:00"),
      "23:00",
      "（翌01:00まで）",
    ],
    [
      "ends exactly at midnight",
      timed("a", "T", "2026-11-08T23:00:00", "2026-11-09T00:00:00"),
      "23:00",
      "",
    ],
    [
      "from yesterday, ends today",
      timed("a", "T", "2026-11-07T23:00:00", "2026-11-08T13:00:00"),
      "前日",
      "（13:00まで）",
    ],
    [
      "from yesterday, ends tomorrow",
      timed("a", "T", "2026-11-07T23:00:00", "2026-11-09T02:00:00"),
      "前日",
      "（翌02:00まで）",
    ],
    [
      "ends two days later",
      timed("a", "T", "2026-11-08T13:00:00", "2026-11-10T10:00:00"),
      "13:00",
      "（11/10 10:00まで）",
    ],
    [
      "from yesterday, ends later",
      timed("a", "T", "2026-11-06T10:00:00", "2026-11-12T09:30:00"),
      "前日",
      "（11/12 09:30まで）",
    ],
  ])("time and end notation: %s", (_n, event, time, until) => {
    expect(row(event)).toMatchObject({ time, until });
  });

  it("titles: blank becomes （タイトルなし）; all-day chips show a later last day", () => {
    expect(
      row(timed("a", "  ", "2026-11-08T13:00:00", "2026-11-08T14:00:00")).title,
    ).toBe("（タイトルなし）");
    expect(
      scheduleList(
        data([
          allDay("one", "", "2026-11-08", "2026-11-09"),
          allDay("multi", "旅行", "2026-11-07", "2026-11-10"),
          allDay("endsToday", "連休", "2026-11-06", "2026-11-09"),
        ]),
        NOW,
      ).allDay,
    ).toEqual([
      { id: "endsToday", title: "連休", until: "" },
      { id: "multi", title: "旅行", until: "（11/9まで）" },
      { id: "one", title: "（タイトルなし）", until: "" },
    ]);
  });
});

describe("fitSchedule (UI 5.1 overflow)", () => {
  const hours = (prefix: string, n: number, from: number, minutes = 20) =>
    Array.from({ length: n }, (_, i) => {
      const start = new Date(
        jst("2026-11-08T00:00:00") + (from * 60 + i * minutes) * 60_000,
      );
      const end = new Date(start.getTime() + 10 * 60_000);
      return {
        id: `${prefix}${String(i).padStart(2, "0")}`,
        title: `${prefix}${i}`,
        allDay: false as const,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
      };
    });

  it("shows everything when it fits", () => {
    const list = scheduleList(
      data([...hours("e", 2, 8), ...hours("u", 5, 13)]),
      NOW,
    );
    expect(fitSchedule(list, false)).toMatchObject({
      endedSummary: null,
      hidden: 0,
      ended: list.ended,
      later: list.later,
    });
  });

  it("collapses ended first, then hides the latest events as ほか N件", () => {
    const list = scheduleList(
      data([...hours("e", 6, 6), ...hours("u", 14, 13)]),
      NOW,
    );
    const fitted = fitSchedule(list, false);
    expect(fitted.ended).toEqual([]);
    expect(fitted.endedSummary).toBe("終了済み 6件（06:00 e0 ほか）");
    expect(fitted.next?.id).toBe("u00");
    expect(fitted.hidden).toBeGreaterThan(0);
    expect(fitted.later).toEqual(
      list.later.slice(0, list.later.length - fitted.hidden),
    );
  });

  it("a single ended event is summarized without ほか", () => {
    const list = scheduleList(
      data([...hours("e", 1, 6), ...hours("u", 13, 13)]),
      NOW,
    );
    const fitted = fitSchedule(list, false);
    expect(fitted.endedSummary).toBe("終了済み 1件（06:00 e0）");
  });

  it("never drops ongoing or the next event, even when they alone overflow", () => {
    const ongoing = Array.from({ length: 2 }, (_, i) =>
      timed(`o${i}`, "", "2026-11-08T11:00:00", "2026-11-08T13:00:00"),
    );
    const list = scheduleList(
      data([...ongoing, ...hours("u", 30, 13, 10)]),
      NOW,
    );
    const fitted = fitSchedule(list, true);
    expect(fitted.ongoing).toHaveLength(2);
    expect(fitted.next).not.toBeNull();
    expect(fitted.hidden + fitted.later.length).toBe(list.later.length);
  });
});

describe("signageModel priorities (11.6)", () => {
  const snapshot = (
    status: "waiting" | "received" | "neverReceived",
    schedule?: PublishedState,
  ) => ({
    status,
    states: schedule ? { schedule } : {},
    at: NOW,
  });

  it("first response pending → loading card, nothing rotates", () => {
    const m = signageModel(snapshot("waiting"), NOW);
    expect([...m.displayable]).toEqual([]);
    expect(m.notice).toBe("loading");
  });

  it("never received → the all-unavailable card", () => {
    const m = signageModel(snapshot("neverReceived"), NOW);
    expect([...m.displayable]).toEqual([]);
    expect(m.notice).toBe("unavailable");
  });

  it("schedule joins the rotation only when it can be shown; weather placeholders stay", () => {
    expect(
      [
        ...signageModel(snapshot("received", state([])), NOW).displayable,
      ].sort(),
    ).toEqual(["schedule", "todayWeather", "weeklyWeather"]);
    for (const s of [
      undefined,
      state(null),
      state(null, { lastAttemptAt: null, lastAttemptResult: null }),
    ])
      expect(
        [...signageModel(snapshot("received", s), NOW).displayable].sort(),
      ).toEqual(["todayWeather", "weeklyWeather"]);
  });
});
