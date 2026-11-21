import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodayWeatherPanel } from "../../src/frontend/weather/TodayWeatherPanel";
import {
  todayWeatherView,
  type CurrentWeather,
  type HourlySlot,
  type PartView,
} from "../../src/frontend/weather/weather-state";

// 今日の天気の時間別の枠のMarkup（UI設計 5.2、Issue #98）。合成データのみ。
// 寸法・見た目は検証画面で実測・目視する。ここではclassと要素の分け方だけを確かめる。

const H = 3_600_000;
const START = Date.parse("2026-11-08T23:00:00+09:00");

const slot = (index: number, extra: Partial<HourlySlot> = {}): HourlySlot => ({
  validAt: new Date(START + index * H).toISOString(),
  label: `${(23 + index) % 24}時`,
  dayStart: false,
  category: "cloudy",
  night: true,
  temperature: -10 + index,
  precipitation: 100,
  wet: true,
  ...extra,
});
const current: PartView<CurrentWeather> = {
  kind: "shown",
  stale: null,
  value: { temperature: -10, category: "unknown", night: false },
};
const render = (slots: readonly HourlySlot[]) =>
  renderToStaticMarkup(
    createElement(TodayWeatherPanel, {
      view: todayWeatherView(
        current,
        { kind: "shown", stale: null, value: slots },
        { kind: "unavailable" },
      ),
    }),
  );
const slotClasses = (html: string) =>
  [...html.matchAll(/class="(weather-slot[^"]*)"/g)]
    .map((m) => m[1]!)
    .filter((c) => !/weather-slot-/.test(c));

describe("hourly slot markup (UI設計 5.2、Issue #98)", () => {
  it("marks only the first slot; the second row's first slot is not marked", () => {
    const html = render(Array.from({ length: 12 }, (_, i) => slot(i)));
    const classes = slotClasses(html);
    expect(classes).toHaveLength(12);
    expect(classes[0]).toBe("weather-slot is-first");
    expect(classes.slice(1).every((c) => c === "weather-slot")).toBe(true);
  });

  it("keeps both marks when the first slot is 明日 0時", () => {
    const html = render([
      slot(0, { label: "明日 0時", dayStart: true }),
      slot(1),
    ]);
    expect(slotClasses(html)).toEqual([
      "weather-slot is-first is-day-start",
      "weather-slot",
    ]);
  });

  it("puts the degree sign outside the centered number, including the sign", () => {
    const html = render([slot(0), slot(15, { temperature: 5 })]);
    expect(html).toContain(
      '<span class="weather-slot-temp">-10<span class="weather-slot-degree">°</span></span>',
    );
    expect(html).toContain(
      '<span class="weather-slot-temp">5<span class="weather-slot-degree">°</span></span>',
    );
    expect(html).toContain("100%");
  });
});
