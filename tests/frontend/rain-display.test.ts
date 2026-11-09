import { describe, expect, it } from "vitest";
import {
  parsePublishedStates,
  type PublishedState,
  type PublishedStates,
} from "../../src/frontend/published-state/schema";
import {
  EXCLUDED_FROM_LOADING_JUDGEMENT,
  signageModel,
} from "../../src/frontend/signage-model";
import { validRainForecastShape } from "../../src/frontend/weather/weather-data";
import {
  isRainDisplayable,
  isTodayWeatherDisplayable,
  rainBand,
  rainForecastView,
  todayWeatherView,
  type PartView,
} from "../../src/frontend/weather/weather-state";

// 降雨帯のDomain検証・表示状態・巡回への参加（technology-stack 21.6・21.9、UI設計 5.2・6.1・6.2・
// 6.5、frontend-development 12.5）。合成データのみ。描画は検証画面で目視する。

const MIN = 60_000;
const H = 60 * MIN;
const jst = (s: string) => Date.parse(`${s}+09:00`);
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = jst("2026-11-08T14:30:00");

const rainData = (extra: Record<string, unknown> = {}) => ({
  status: "dry",
  intensity: "light",
  rainStartAt: iso(NOW + 20 * MIN),
  rainEndAt: iso(NOW + 45 * MIN),
  forecastUntil: iso(NOW + 60 * MIN),
  ...extra,
});
/** `ageMin`分前に取得した降雨のState。 */
const rainState = (
  data: Record<string, unknown>,
  ageMin = 2,
  extra: Partial<PublishedState["meta"]> = {},
): PublishedState => ({
  data,
  meta: {
    dataUpdatedAt: iso(NOW - ageMin * MIN),
    expiresAt: iso(NOW + 3 * H),
    lastAttemptAt: iso(NOW - ageMin * MIN),
    lastAttemptResult: "success",
    publishedAt: iso(NOW - ageMin * MIN),
    dataSource: "externalApi",
    ...extra,
  },
});
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
const view = (state: PublishedState | undefined, now = NOW) =>
  rainForecastView(state, "received", now);

describe("validRainForecastShape (21.3)", () => {
  it("accepts the Domain Data shapes", () => {
    for (const data of [
      rainData(),
      rainData({ rainEndAt: null }),
      rainData({ status: "raining", rainStartAt: null }),
      rainData({ status: "raining", rainStartAt: null, rainEndAt: null }),
      rainData({
        intensity: null,
        rainStartAt: null,
        rainEndAt: null,
      }),
    ])
      expect(validRainForecastShape(data)).toBe(true);
  });
  it("rejects wrong types, extra properties and inconsistent combinations", () => {
    for (const data of [
      null,
      [],
      rainData({ extra: 1 }),
      rainData({ status: "wet" }),
      rainData({ intensity: "extreme" }),
      rainData({ forecastUntil: "2026-11-08T14:30:00+09:00" }),
      rainData({ rainStartAt: "tomorrow" }),
      rainData({ rainEndAt: 5 }),
      // no event but a time is given
      rainData({ intensity: null, rainEndAt: null }),
      // raining now cannot have a start in the future
      rainData({ status: "raining" }),
      // an upcoming event needs a start, and the end must come after it
      rainData({ rainStartAt: null }),
      rainData({ rainEndAt: iso(NOW + 20 * MIN) }),
    ])
      expect(validRainForecastShape(data)).toBe(false);
  });
  it("an invalid rainForecast is omitted from the Response; valid ones are kept", () => {
    const envelope = (data: unknown) => ({
      schemaVersion: 1,
      states: { rainForecast: rainState(data as Record<string, unknown>) },
    });
    expect(
      parsePublishedStates(envelope(rainData()))?.rainForecast,
    ).toBeDefined();
    expect(
      parsePublishedStates(envelope(rainData({ extra: 1 })))?.rainForecast,
    ).toBeUndefined();
  });
});

describe("rainBand texts and the recalculated remaining time (UI 5.2)", () => {
  const at = (data: Record<string, unknown>, now = NOW) =>
    rainBand(data as never, now);
  it("an upcoming rain: the time rounded to 5 minutes + remaining minutes", () => {
    expect(
      at(rainData({ rainStartAt: iso(jst("2026-11-08T14:52:00")) })),
    ).toEqual({
      kind: "rain",
      text: "14:50ごろから弱い雨",
      remaining: "あと約20分",
    });
    expect(
      at(rainData({ rainStartAt: iso(jst("2026-11-08T14:53:00")) })),
    ).toMatchObject({ text: "14:55ごろから弱い雨" });
    expect(
      at(rainData({ intensity: "heavy", rainStartAt: iso(NOW + 30 * MIN) })),
    ).toMatchObject({ text: "15:00ごろから強い雨" });
  });
  it("remaining time: under 5 minutes is 'まもなく', then 5-minute steps", () => {
    const remaining = (minutes: number) =>
      (
        at(rainData({ rainStartAt: iso(NOW + minutes * MIN) })) as {
          remaining: string;
        }
      ).remaining;
    expect(remaining(0.5)).toBe("まもなく");
    expect(remaining(4.99)).toBe("まもなく");
    expect(remaining(5)).toBe("あと約5分");
    expect(remaining(7.4)).toBe("あと約5分");
    expect(remaining(7.5)).toBe("あと約10分");
    expect(remaining(20)).toBe("あと約20分");
  });
  it("raining: the end or 'しばらく続く見込み'; no countdown", () => {
    expect(
      at(
        rainData({
          status: "raining",
          intensity: "moderate",
          rainStartAt: null,
          rainEndAt: iso(jst("2026-11-08T15:40:00")),
        }),
      ),
    ).toEqual({
      kind: "rain",
      text: "普通の雨　15:40ごろやむ見込み",
      remaining: null,
    });
    expect(
      at(
        rainData({
          status: "raining",
          rainStartAt: null,
          rainEndAt: null,
        }),
      ),
    ).toEqual({
      kind: "rain",
      text: "弱い雨　しばらく続く見込み",
      remaining: null,
    });
  });
  it("no event: 'none'", () => {
    expect(
      at(rainData({ intensity: null, rainStartAt: null, rainEndAt: null })),
    ).toEqual({ kind: "none" });
  });
  it("a passed forecast time is 'passed' and the rain state is not guessed", () => {
    expect(at(rainData({ rainStartAt: iso(NOW) }))).toEqual({ kind: "passed" });
    expect(at(rainData({ rainStartAt: iso(NOW - MIN) }))).toEqual({
      kind: "passed",
    });
    expect(
      at(
        rainData({
          status: "raining",
          rainStartAt: null,
          rainEndAt: iso(NOW - MIN),
        }),
      ),
    ).toEqual({ kind: "passed" });
  });
});

describe("rainForecastView states (21.6, UI 6.1)", () => {
  it("before the first response / without data", () => {
    expect(rainForecastView(undefined, "waiting", NOW)).toEqual({
      kind: "loading",
    });
    expect(view(undefined)).toEqual({ kind: "unavailable" });
    expect(view(noData(null))).toEqual({ kind: "loading" });
    expect(view(noData(iso(NOW - MIN)))).toEqual({ kind: "unavailable" });
  });
  it("under 10 minutes: the forecast, without a note when the last attempt succeeded", () => {
    const shown = view(rainState(rainData(), 9.99));
    expect(shown).toMatchObject({ kind: "shown", stale: null });
    expect(shown.kind === "shown" && shown.band.kind).toBe("rain");
  });
  it("under 10 minutes after a failed attempt: the forecast with the last update time", () => {
    expect(
      view(
        rainState(rainData(), 6, {
          lastAttemptResult: "failure",
          lastAttemptAt: iso(NOW - MIN),
          dataSource: "cache",
        }),
      ),
    ).toMatchObject({ kind: "shown", stale: { since: "14:24" } });
  });
  it("10 to 30 minutes: the forecast is hidden, with the last update time", () => {
    expect(view(rainState(rainData(), 10))).toEqual({
      kind: "waiting",
      since: "14:20",
    });
    expect(view(rainState(rainData(), 29.99))).toMatchObject({
      kind: "waiting",
    });
  });
  it("30 minutes or more, expired, or a future update time: unavailable", () => {
    expect(view(rainState(rainData(), 30))).toEqual({ kind: "unavailable" });
    expect(view(rainState(rainData(), 5, { expiresAt: iso(NOW) }))).toEqual({
      kind: "unavailable",
    });
    expect(view(rainState(rainData(), -1))).toEqual({ kind: "unavailable" });
  });
  it("a passed forecast time inside the 10 minutes shows a note instead of guessing", () => {
    const state = rainState(rainData({ rainStartAt: iso(NOW - MIN) }), 8);
    expect(view(state)).toMatchObject({
      kind: "shown",
      band: { kind: "passed" },
      stale: { since: "14:22" },
    });
  });
  it("the same State moves on with time: countdown, soon, passed, hidden, unavailable", () => {
    const state = rainState(rainData({ rainStartAt: iso(NOW + 8 * MIN) }), 0);
    const at = (minutes: number) => view(state, NOW + minutes * MIN);
    const text = (v: ReturnType<typeof at>) =>
      v.kind === "shown" && v.band.kind === "rain"
        ? v.band.remaining
        : v.kind === "shown"
          ? v.band.kind
          : v.kind;
    expect(text(at(0))).toBe("あと約10分");
    expect(text(at(4))).toBe("まもなく");
    expect(text(at(8))).toBe("passed");
    expect(text(at(10))).toBe("waiting");
    expect(text(at(30))).toBe("unavailable");
  });
});

describe("rotation and the whole-content judgement", () => {
  const none = { kind: "unavailable" } as const;
  const part = <T>(value: T): PartView<T> => ({
    kind: "shown",
    stale: null,
    value,
  });
  const today = (rain: ReturnType<typeof view>) =>
    isTodayWeatherDisplayable(todayWeatherView(none, none, none, rain));
  it("only a shown forecast keeps Today's weather in the rotation", () => {
    expect(today(view(rainState(rainData())))).toBe(true);
    expect(
      today(
        view(
          rainState(
            rainData({ intensity: null, rainStartAt: null, rainEndAt: null }),
          ),
        ),
      ),
    ).toBe(true); // "no rain expected" is information too
    expect(today(view(rainState(rainData(), 15)))).toBe(false); // waiting
    expect(
      today(view(rainState(rainData({ rainStartAt: iso(NOW - MIN) }), 5))),
    ).toBe(false); // passed
    expect(today(view(undefined))).toBe(false);
    expect(isRainDisplayable({ kind: "loading" })).toBe(false);
    // The other parts decide as before.
    expect(
      isTodayWeatherDisplayable(
        todayWeatherView(part({} as never), none, none, view(undefined)),
      ),
    ).toBe(true);
  });

  const snapshot = (states: PublishedStates) => ({
    status: "received" as const,
    states,
    at: NOW,
  });
  const loadingAll = {
    schedule: noData(null),
    currentWeather: noData(null),
    hourlyWeather: noData(null),
    weeklyWeather: noData(null),
  } as PublishedStates;
  it("rainForecast is never counted in the loading judgement (MVP specification)", () => {
    expect([...EXCLUDED_FROM_LOADING_JUDGEMENT]).toEqual(["rainForecast"]);
    for (const rain of [undefined, noData(null), noData(iso(NOW - MIN))]) {
      const m = signageModel(
        snapshot({
          ...loadingAll,
          ...(rain ? { rainForecast: rain } : {}),
        }),
        NOW,
      );
      expect([...m.displayable]).toEqual([]);
      expect(m.notice).toBe("loading");
    }
  });
  it("another State's failure is still counted", () => {
    const m = signageModel(
      snapshot({
        ...loadingAll,
        schedule: noData(iso(NOW - MIN)),
      }),
      NOW,
    );
    expect(m.notice).toBe("unavailable");
  });
  it("a shown forecast alone keeps Today's weather; the rain band shows its own state", () => {
    const m = signageModel(
      snapshot({
        ...loadingAll,
        rainForecast: rainState(rainData()),
      }),
      NOW,
    );
    expect([...m.displayable]).toEqual(["todayWeather"]);
    expect(m.todayWeather.rain).toMatchObject({ kind: "shown" });
  });
  it("only the rainForecast failing leaves the other contents untouched", () => {
    const m = signageModel(
      snapshot({
        ...loadingAll,
        rainForecast: noData(iso(NOW - MIN)),
      }),
      NOW,
    );
    expect(m.todayWeather.rain).toEqual({ kind: "unavailable" });
    expect(m.notice).toBe("loading"); // nothing displayable, nothing counted against it
  });
});
