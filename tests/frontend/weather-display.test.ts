import { describe, expect, it } from "vitest";
import { weatherIconName } from "../../src/frontend/icons/WeatherIcons";
import {
  parsePublishedStates,
  type PublishedState,
  type PublishedStates,
} from "../../src/frontend/published-state/schema";
import {
  signageModel,
  UNIMPLEMENTED_STATES,
} from "../../src/frontend/signage-model";
import {
  validCurrentWeatherShape,
  validHourlyWeatherShape,
  validWeeklyWeatherShape,
} from "../../src/frontend/weather/weather-data";
import {
  currentWeatherView,
  hourlyWeatherView,
  isTodayWeatherDisplayable,
  rounded,
  todayWeatherView,
  WEATHER_NAMES,
  weatherCategory,
  weeklyWeatherView,
  type HourlySlot,
  type PartView,
  type WeeklyDay,
} from "../../src/frontend/weather/weather-state";

// 天気のDomain検証・Component State・巡回への参加（docs/frontend-development.md 12.3〜12.5、
// UI設計 5.2〜5.4・6.1・6.2・6.5）。合成データのみ。描画は検証画面で目視する。

const H = 3_600_000;
const D = 24 * H;
const jst = (s: string) => Date.parse(`${s}+09:00`);
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = jst("2026-11-08T10:25:00"); // 日曜

const meta = (
  extra: Partial<PublishedState["meta"]> = {},
): PublishedState["meta"] => ({
  dataUpdatedAt: iso(NOW - 10 * 60_000),
  expiresAt: iso(NOW + 2 * H),
  lastAttemptAt: iso(NOW - 10 * 60_000),
  lastAttemptResult: "success",
  publishedAt: iso(NOW - 10 * 60_000),
  dataSource: "externalApi",
  ...extra,
});
const stale = {
  dataUpdatedAt: iso(jst("2026-11-08T09:05:00")),
  lastAttemptAt: iso(NOW - 60_000),
  lastAttemptResult: "failure" as const,
  dataSource: "cache" as const,
};
const noData = (lastAttemptAt: string | null): PublishedState => ({
  data: null,
  meta: {
    dataUpdatedAt: null,
    expiresAt: null,
    lastAttemptAt,
    lastAttemptResult: lastAttemptAt === null ? null : "failure",
    publishedAt: iso(NOW),
    dataSource: null,
  },
});

const currentData = (extra: Record<string, unknown> = {}) => ({
  temperatureC: 17.6,
  weatherCode: 3,
  isDay: true,
  validAt: iso(jst("2026-11-08T10:15:00")),
  ...extra,
});
/** `from`（JST）から`count`枠。 */
const hoursData = (from = "2026-11-08T11:00:00", count = 36) => ({
  hours: Array.from({ length: count }, (_, i) => ({
    validAt: iso(jst(from) + i * H),
    temperatureC: 10 + i / 10,
    weatherCode: 2,
    precipitationProbability: i % 2 === 0 ? 50 : 49.6,
  })),
});
/** `from`（JST暦日）から`count`日。 */
const daysData = (from = "2026-11-08", count = 9) => ({
  days: Array.from({ length: count }, (_, i) => ({
    date: new Date(jst(`${from}T12:00:00`) + i * D + 9 * H)
      .toISOString()
      .slice(0, 10),
    weatherCode: 61,
    temperatureMaxC: 20 + i,
    temperatureMinC: 10 + i,
    precipitationProbability: 40,
  })),
});
const state = (
  data: Record<string, unknown>,
  extra: Partial<PublishedState["meta"]> = {},
): PublishedState => ({ data, meta: meta(extra) });

const shown = <T>(view: PartView<T>) => {
  expect(view.kind).toBe("shown");
  return view as Extract<PartView<T>, { kind: "shown" }>;
};
const hourly = (data = hoursData(), now = NOW) =>
  hourlyWeatherView(
    state(data, { expiresAt: iso(NOW + 3 * D) }),
    "received",
    now,
  );
const labels = (view: PartView<readonly HourlySlot[]>) =>
  shown(view).value.map((s) => s.label);
const weekly = (data = daysData(), now = NOW) =>
  weeklyWeatherView(
    state(data, { expiresAt: iso(NOW + 3 * D) }),
    "received",
    now,
  );
const dates = (view: PartView<readonly WeeklyDay[]>) =>
  shown(view).value.map((d) => d.date);

describe("weather Domain validation (12.1)", () => {
  it("accepts the Backend output", () => {
    expect(validCurrentWeatherShape(currentData())).toBe(true);
    expect(validCurrentWeatherShape(currentData({ weatherCode: 1234 }))).toBe(
      true,
    );
    expect(validHourlyWeatherShape(hoursData())).toBe(true);
    expect(validWeeklyWeatherShape(daysData())).toBe(true);
  });

  it("does not check the counts (24 slots / 7 days); short data is handled at display", () => {
    expect(validHourlyWeatherShape(hoursData(undefined, 3))).toBe(true);
    expect(validHourlyWeatherShape({ hours: [] })).toBe(true);
    expect(validWeeklyWeatherShape(daysData(undefined, 2))).toBe(true);
  });

  it.each([
    ["isDay as a number", { isDay: 1 }],
    ["a non-integer code", { weatherCode: 2.5 }],
    ["a string temperature", { temperatureC: "17" }],
    ["validAt not in toISOString form", { validAt: "2026-11-08T01:15:00Z" }],
    ["validAt with an offset", { validAt: "2026-11-08T10:15:00.000+09:00" }],
    ["an extra field", { interval: 900 }],
  ])("rejects a current weather with %s", (_label, extra) => {
    expect(validCurrentWeatherShape(currentData(extra))).toBe(false);
  });

  it.each([
    [
      "a time that is not on the hour",
      (h: Record<string, unknown>[]) =>
        (h[2]!.validAt = iso(jst("2026-11-08T13:30:00"))),
    ],
    ["a gap", (h: Record<string, unknown>[]) => h.splice(3, 1)],
    [
      "a duplicate",
      (h: Record<string, unknown>[]) => (h[3]!.validAt = h[2]!.validAt),
    ],
    ["reversed slots", (h: Record<string, unknown>[]) => h.reverse()],
    [
      "precipitation 101",
      (h: Record<string, unknown>[]) => (h[0]!.precipitationProbability = 101),
    ],
    [
      "a null temperature",
      (h: Record<string, unknown>[]) => (h[0]!.temperatureC = null),
    ],
  ])("rejects hourly weather with %s", (_label, broke) => {
    const data = hoursData();
    broke(data.hours as unknown as Record<string, unknown>[]);
    expect(validHourlyWeatherShape(data)).toBe(false);
  });

  it.each([
    [
      "min > max",
      (d: Record<string, unknown>[]) => (d[1]!.temperatureMinC = 99),
    ],
    [
      "a non-existent date",
      (d: Record<string, unknown>[]) => (d[0]!.date = "2026-11-31"),
    ],
    ["a gap", (d: Record<string, unknown>[]) => d.splice(2, 1)],
    [
      "a duplicate",
      (d: Record<string, unknown>[]) => (d[2]!.date = d[1]!.date),
    ],
    [
      "precipitation -1",
      (d: Record<string, unknown>[]) => (d[0]!.precipitationProbability = -1),
    ],
  ])("rejects weekly weather with %s", (_label, broke) => {
    const data = daysData();
    broke(data.days as unknown as Record<string, unknown>[]);
    expect(validWeeklyWeatherShape(data)).toBe(false);
  });

  it("drops only the invalid weather State from the Response (11.3)", () => {
    const parsed = parsePublishedStates({
      schemaVersion: 1,
      states: {
        currentWeather: state(currentData({ weatherCode: "3" })),
        hourlyWeather: state(hoursData()),
        weeklyWeather: state(daysData()),
      },
    });
    expect(Object.keys(parsed!).sort()).toEqual([
      "hourlyWeather",
      "weeklyWeather",
    ]);
  });
});

describe("weather code categories (UI設計 5.4)", () => {
  it.each([
    [[0, 1], "clear"],
    [[2, 3], "cloudy"],
    [[45, 48], "fog"],
    [[51, 61, 67, 80, 82], "rain"],
    [[71, 77, 85, 86], "snow"],
    [[95, 99], "storm"],
    [[4, 50, 68, 70, 78, 83, 84, 87, 94, 100, -1], "unknown"],
  ] as const)("%j → %s", (codes, category) => {
    for (const code of codes) expect(weatherCategory(code)).toBe(category);
  });

  it("names and icons each category; clear at night is the moon", () => {
    expect(Object.values(WEATHER_NAMES)).toEqual([
      "晴れ",
      "くもり",
      "霧",
      "雨",
      "雪",
      "雷雨",
      "天気不明",
    ]);
    expect(weatherIconName("clear", false)).toBe("sun");
    expect(weatherIconName("clear", true)).toBe("moon");
    expect(weatherIconName("cloudy", true)).toBe("cloud");
    expect(weatherIconName("unknown", false)).toBe("questionMark");
  });

  it("rounds temperatures and probabilities to integers, without -0", () => {
    expect(rounded(17.6)).toBe(18);
    expect(rounded(-0.4)).toBe(0);
    expect(Object.is(rounded(-0.4), 0)).toBe(true);
    expect(rounded(-2.6)).toBe(-3);
  });
});

describe("weather display states (12.3)", () => {
  it("a missing State is unavailable; it is loading only before the first response", () => {
    expect(currentWeatherView(undefined, "received", NOW)).toEqual({
      kind: "unavailable",
    });
    expect(currentWeatherView(undefined, "waiting", NOW)).toEqual({
      kind: "loading",
    });
  });

  it("no data: loading before the first attempt, unavailable after it", () => {
    expect(hourlyWeatherView(noData(null), "received", NOW)).toEqual({
      kind: "loading",
    });
    expect(hourlyWeatherView(noData(iso(NOW)), "received", NOW)).toEqual({
      kind: "unavailable",
    });
  });

  it("is unavailable from expiresAt (now >= expiresAt)", () => {
    const s = state(currentData(), { expiresAt: iso(NOW) });
    expect(currentWeatherView(s, "received", NOW - 1).kind).toBe("shown");
    expect(currentWeatherView(s, "received", NOW)).toEqual({
      kind: "unavailable",
    });
  });

  it("shows the stale badge from dataUpdatedAt only after a failed attempt, not by dataSource", () => {
    expect(
      shown(currentWeatherView(state(currentData(), stale), "received", NOW))
        .stale,
    ).toEqual({ since: "09:05" });
    expect(
      shown(
        currentWeatherView(
          state(currentData(), { dataSource: "cache" }),
          "received",
          NOW,
        ),
      ).stale,
    ).toBeNull();
    expect(
      shown(
        currentWeatherView(
          state(currentData(), {
            ...stale,
            dataUpdatedAt: iso(jst("2026-11-07T23:50:00")),
          }),
          "received",
          NOW,
        ),
      ).stale,
    ).toEqual({ since: "11/7 23:50" });
  });

  it("current weather: rounded temperature, category and night from isDay; no freshness re-check", () => {
    expect(
      shown(currentWeatherView(state(currentData()), "received", NOW)).value,
    ).toEqual({ temperature: 18, category: "cloudy", night: false });
    // validAtが1時間前でも、公開時に30分の制限を再適用しない（19.4）。
    const old = currentData({
      isDay: false,
      weatherCode: 0,
      validAt: iso(NOW - H),
    });
    expect(
      shown(currentWeatherView(state(old), "received", NOW)).value,
    ).toEqual({ temperature: 18, category: "clear", night: true });
  });
});

describe("hourly selection (20.5)", () => {
  it("selects 12 slots from the next hour", () => {
    expect(labels(hourly())).toEqual([
      "11時",
      "12時",
      "13時",
      "14時",
      "15時",
      "16時",
      "17時",
      "18時",
      "19時",
      "20時",
      "21時",
      "22時",
    ]);
  });

  it("includes the hour itself at an exact hour", () => {
    expect(labels(hourly(hoursData(), jst("2026-11-08T11:00:00")))[0]).toBe(
      "11時",
    );
    expect(labels(hourly(hoursData(), jst("2026-11-08T11:00:00") + 1))[0]).toBe(
      "12時",
    );
  });

  it("re-selects with the current time without a new Response, past slots are dropped", () => {
    expect(labels(hourly(hoursData(), jst("2026-11-08T14:10:00")))[0]).toBe(
      "15時",
    );
  });

  it("marks the slot crossing midnight as 明日 0時, and night from 18:00 to 05:59", () => {
    const slots = shown(hourly(hoursData(), jst("2026-11-08T17:30:00"))).value;
    expect(slots.map((s) => s.label)).toEqual([
      "18時",
      "19時",
      "20時",
      "21時",
      "22時",
      "23時",
      "明日 0時",
      "1時",
      "2時",
      "3時",
      "4時",
      "5時",
    ]);
    expect(slots.map((s) => s.dayStart)).toEqual(
      slots.map((s) => s.label === "明日 0時"),
    );
    expect(slots.every((s) => s.night)).toBe(true);
    const morning = shown(
      hourly(hoursData("2026-11-09T05:00:00"), jst("2026-11-09T04:30:00")),
    ).value;
    expect(morning.slice(0, 2).map((s) => [s.label, s.night])).toEqual([
      ["5時", true],
      ["6時", false],
    ]);
  });

  it("shows only the existing slots when fewer than 12 remain", () => {
    expect(labels(hourly(hoursData(undefined, 5)))).toEqual([
      "11時",
      "12時",
      "13時",
      "14時",
      "15時",
    ]);
  });

  it("no slot from the next hour is noForecast, distinct from an API failure", () => {
    expect(hourly(hoursData(undefined, 3), jst("2026-11-08T13:30:00"))).toEqual(
      { kind: "noForecast" },
    );
    // 次の正時の枠がなく、それより後の枠だけがある場合も選ばない。
    expect(hourly(hoursData("2026-11-08T13:00:00"))).toEqual({
      kind: "noForecast",
    });
  });

  it("rounds values and highlights 50% or more as wet", () => {
    const [first, second] = shown(hourly()).value;
    expect(first).toMatchObject({ precipitation: 50, wet: true });
    expect(second).toMatchObject({ precipitation: 50, wet: false });
  });
});

describe("weekly selection (22.5)", () => {
  it("selects 7 days from today, with labels, dates and weekends", () => {
    const days = shown(weekly()).value;
    expect(days.map((d) => d.date)).toEqual([
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
    ]);
    expect(days.map((d) => d.label)).toEqual([
      "今日",
      "明日",
      "火曜",
      "水曜",
      "木曜",
      "金曜",
      "土曜",
    ]);
    expect(days[0]).toMatchObject({ monthDay: "11/8", weekend: "sun" });
    expect(days[6]).toMatchObject({ weekend: "sat" });
    expect(days.filter((d) => d.today)).toHaveLength(1);
  });

  it("switches to the next day at JST midnight without a new Response", () => {
    expect(dates(weekly(daysData(), jst("2026-11-08T23:59:59")))[0]).toBe(
      "2026-11-08",
    );
    expect(dates(weekly(daysData(), jst("2026-11-09T00:00:00")))[0]).toBe(
      "2026-11-09",
    );
  });

  it("shows 1-6 days when fewer remain; none from today is noForecast", () => {
    expect(dates(weekly(daysData(undefined, 3)))).toHaveLength(3);
    expect(weekly(daysData(undefined, 3), jst("2026-11-11T08:00:00"))).toEqual({
      kind: "noForecast",
    });
    // 明日からの予報だけでは、今日として表示しない。
    expect(weekly(daysData("2026-11-09"))).toEqual({ kind: "noForecast" });
  });

  it("positions the temperature bar within the shown days' range", () => {
    const days = shown(weekly()).value;
    // 表示する7日：最低10〜16、最高20〜26 → 範囲10〜26。
    expect(days[0]).toMatchObject({ barLeft: 0, barRight: 37.5 });
    expect(days[6]).toMatchObject({ barLeft: 37.5, barRight: 0 });
  });

  it("uses a full-width bar when every day has the same temperature", () => {
    const data = daysData(undefined, 1);
    data.days[0]!.temperatureMaxC = 12;
    data.days[0]!.temperatureMinC = 12;
    expect(shown(weekly(data)).value[0]).toMatchObject({
      barLeft: 0,
      barRight: 0,
    });
  });
});

describe("today's weather (UI設計 5.2・6.2)", () => {
  const current = currentWeatherView(state(currentData()), "received", NOW);

  it("shows high / low only when today's weekly weather can be shown", () => {
    expect(todayWeatherView(current, hourly(), weekly()).highLow).toEqual({
      max: 20,
      min: 10,
    });
    expect(
      todayWeatherView(current, hourly(), { kind: "unavailable" }).highLow,
    ).toBeNull();
    expect(
      todayWeatherView(current, hourly(), weekly(daysData("2026-11-09")))
        .highLow,
    ).toBeNull();
  });

  it("stays in the rotation while the current or hourly weather can be shown", () => {
    const none = { kind: "unavailable" } as const;
    expect(
      isTodayWeatherDisplayable(todayWeatherView(current, none, none)),
    ).toBe(true);
    expect(
      isTodayWeatherDisplayable(todayWeatherView(none, hourly(), none)),
    ).toBe(true);
    // 週間天気だけでは今日の天気は残らない（降雨は#93まで常に表示できない）。
    expect(
      isTodayWeatherDisplayable(todayWeatherView(none, none, weekly())),
    ).toBe(false);
  });
});

describe("signageModel with weather (12.5)", () => {
  const snapshot = (states: PublishedStates) => ({
    status: "received" as const,
    states,
    at: NOW,
  });
  const all = (s: PublishedState): PublishedStates => ({
    schedule: s,
    currentWeather: s,
    hourlyWeather: s,
    weeklyWeather: s,
  });

  it("adds today's and weekly weather to the rotation when they can be shown", () => {
    const m = signageModel(
      snapshot({
        currentWeather: state(currentData()),
        hourlyWeather: state(hoursData()),
        weeklyWeather: state(daysData()),
      }),
      NOW,
    );
    expect([...m.displayable]).toEqual(["todayWeather", "weeklyWeather"]);
    expect(m.todayWeather.highLow).toEqual({ max: 20, min: 10 });
  });

  it("partial failure keeps today's weather; weekly 0 days drops weekly only", () => {
    const m = signageModel(
      snapshot({
        currentWeather: noData(iso(NOW)),
        hourlyWeather: state(hoursData()),
        weeklyWeather: state(daysData("2026-11-01", 7)),
      }),
      NOW,
    );
    expect([...m.displayable]).toEqual(["todayWeather"]);
    expect(m.weeklyWeather).toEqual({ kind: "noForecast" });
  });

  it("everything loading → the loading card; the unimplemented rainForecast is not counted", () => {
    expect([...UNIMPLEMENTED_STATES]).toEqual(["rainForecast"]);
    const m = signageModel(snapshot(all(noData(null))), NOW);
    expect([...m.displayable]).toEqual([]);
    expect(m.notice).toBe("loading");
  });

  it("an implemented State's failure or omission is still counted", () => {
    const loading = all(noData(null));
    expect(
      signageModel(
        snapshot({ ...loading, hourlyWeather: noData(iso(NOW)) }),
        NOW,
      ).notice,
    ).toBe("unavailable");
    const rest: PublishedStates = { ...loading };
    delete rest.weeklyWeather;
    expect(signageModel(snapshot(rest), NOW).notice).toBe("unavailable");
    // 有効だが選べる枠が0の時間別も「取得中」ではない。
    expect(
      signageModel(
        snapshot({
          ...loading,
          hourlyWeather: state(hoursData("2026-11-08T13:00:00")),
        }),
        NOW,
      ).notice,
    ).toBe("unavailable");
  });
});
