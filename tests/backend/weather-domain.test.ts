// Issue #9 Weather Domain Schema / Semantic Validation and Open-Meteo time
// parsing (technology-stack 16.6 / 19.2 / 20.1 / 22.2). Synthetic data only.
import { expect, test } from "vitest";
import {
  validCurrentWeatherData,
  validHourlyWeatherData,
  validWeeklyWeatherData,
} from "../../src/backend/weather/weather-data.js";
import {
  forecastBody,
  jstLocalTime,
} from "../../src/backend/weather/open-meteo.js";

const H = 3_600_000;
const hours = (count: number, startMs = Date.parse("2026-11-08T02:00:00Z")) =>
  Array.from({ length: count }, (_, i) => ({
    validAt: new Date(startMs + i * H).toISOString(),
    temperatureC: 12.5,
    weatherCode: 3,
    precipitationProbability: 20,
  }));
const days = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    date: `2026-11-${String(8 + i).padStart(2, "0")}`,
    weatherCode: 61,
    temperatureMaxC: 18,
    temperatureMinC: 8,
    precipitationProbability: 40,
  }));

test.each([
  ["2026-11-08T10:15", "2026-11-08T01:15:00.000Z"],
  ["2026-11-08T00:00", "2026-11-07T15:00:00.000Z"],
  ["2026-01-01T08:59", "2025-12-31T23:59:00.000Z"],
  ["2028-02-29T23:00", "2028-02-29T14:00:00.000Z"],
])("JST local time %s is %s", (local, utc) =>
  expect(new Date(jstLocalTime(local)!).toISOString()).toBe(utc),
);

test.each([
  "2026-02-29T00:00",
  "2026-11-31T00:00",
  "2026-11-08T24:00",
  "2026-11-08T10:60",
  "2026-11-08T10:15:00",
  "2026-11-08T10:15Z",
  "2026-11-08T10:15+09:00",
  "2026-11-08 10:15",
  "2026-11-08",
  "",
  null,
  1_762_560_000_000,
])("JST local time %j is rejected", (value) =>
  expect(jstLocalTime(value)).toBeNull(),
);

test("the Body must be a JSON object with the JST offset", () => {
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  expect(forecastBody(encode({ utc_offset_seconds: 32400 }))).toEqual({
    utc_offset_seconds: 32400,
  });
  expect(forecastBody(encode({ utc_offset_seconds: 0 }))).toBeNull();
  expect(forecastBody(encode({ utc_offset_seconds: 32400.5 }))).toBeNull();
  expect(forecastBody(encode({}))).toBeNull();
  expect(forecastBody(encode(null))).toBeNull();
  expect(forecastBody(new TextEncoder().encode("{"))).toBeNull();
});

test("CurrentWeather Domain Data", () => {
  const data = {
    temperatureC: -3.5,
    weatherCode: 71,
    isDay: false,
    validAt: "2026-11-08T01:15:00.000Z",
  };
  expect(validCurrentWeatherData(data)).toBe(true);
  expect(validCurrentWeatherData({ ...data, weatherCode: 9999 })).toBe(true);
  for (const broken of [
    { ...data, validAt: "2026-11-08T01:15:00Z" }, // not toISOString()
    { ...data, validAt: "2026-11-31T01:15:00.000Z" },
    { ...data, isDay: 1 },
    { ...data, weatherCode: 1.5 },
    { ...data, temperatureC: Number.NaN },
    { ...data, extra: true },
    { temperatureC: 1, weatherCode: 1, isDay: true },
  ])
    expect(validCurrentWeatherData(broken)).toBe(false);
});

test("HourlyWeather Domain Data: 24-36 consecutive full hours", () => {
  expect(validHourlyWeatherData({ hours: hours(24) })).toBe(true);
  expect(validHourlyWeatherData({ hours: hours(36) })).toBe(true);
  expect(validHourlyWeatherData({ hours: hours(23) })).toBe(false);
  expect(validHourlyWeatherData({ hours: hours(37) })).toBe(false);
  expect(
    validHourlyWeatherData({
      hours: hours(24, Date.parse("2026-11-08T02:30:00Z")),
    }),
  ).toBe(false);
  const gap = hours(25);
  gap.splice(5, 1);
  expect(validHourlyWeatherData({ hours: gap })).toBe(false);
  const reversed = hours(24).reverse();
  expect(validHourlyWeatherData({ hours: reversed })).toBe(false);
  const over = hours(24);
  over[3] = { ...over[3]!, precipitationProbability: 100.1 };
  expect(validHourlyWeatherData({ hours: over })).toBe(false);
  expect(validHourlyWeatherData({ hours: hours(24), extra: 1 })).toBe(false);
});

test("WeeklyWeather Domain Data: 7-9 consecutive JST dates", () => {
  expect(validWeeklyWeatherData({ days: days(7) })).toBe(true);
  expect(validWeeklyWeatherData({ days: days(9) })).toBe(true);
  expect(validWeeklyWeatherData({ days: days(6) })).toBe(false);
  expect(validWeeklyWeatherData({ days: days(10) })).toBe(false);
  const gap = days(8);
  gap.splice(2, 1);
  expect(validWeeklyWeatherData({ days: gap })).toBe(false);
  const inverted = days(7);
  inverted[1] = { ...inverted[1]!, temperatureMinC: 19 };
  expect(validWeeklyWeatherData({ days: inverted })).toBe(false);
  const bad = days(7);
  bad[0] = { ...bad[0]!, date: "2026-11-31" };
  expect(validWeeklyWeatherData({ days: bad })).toBe(false);
});
