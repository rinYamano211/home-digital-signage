// RainForecast Domain derivation and Validation (technology-stack 21.3 - 21.5).
import { expect, test } from "vitest";
import {
  parseInstant,
  rainForecastOf,
  requiredWindow,
  slotsOf,
  validRainForecastData,
  type Slot,
} from "../../src/backend/weather/rain-forecast.js";

const MIN = 60_000;
const origin = Date.parse("2026-11-09T12:00:00Z");
const at = (minutes: number) => new Date(origin + minutes * MIN).toISOString();
/** 60 dry slots with `rain` overriding minute -> mm/h. */
const window = (rain: Record<number, number> = {}) => ({
  originMs: origin,
  intensities: Array.from({ length: 60 }, (_, i) => rain[i] ?? 0),
});
const run = (from: number, to: number, value: number) =>
  Object.fromEntries(
    Array.from({ length: to - from + 1 }, (_, i) => [from + i, value]),
  );
const body = (values: unknown[], startMs = origin, timestep = "1m") => ({
  data: {
    timelines: [
      {
        timestep,
        intervals: values.map((rainIntensity, i) => ({
          startTime: new Date(startMs + i * MIN).toISOString(),
          values: { rainIntensity },
        })),
      },
    ],
  },
});

test("no rain in the window: dry, no event, forecastUntil is the exclusive end", () => {
  expect(rainForecastOf(window())).toEqual({
    status: "dry",
    intensity: null,
    rainStartAt: null,
    rainEndAt: null,
    forecastUntil: at(60),
  });
});
test("rain starting later: dry with start / end of the nearest event and its peak", () => {
  expect(rainForecastOf(window({ ...run(10, 14, 0.5), 12: 2 }))).toEqual({
    status: "dry",
    intensity: "moderate",
    rainStartAt: at(10),
    rainEndAt: at(15),
    forecastUntil: at(60),
  });
});
test("raining now: raining, no start, end is the first confirmed dry minute", () => {
  expect(rainForecastOf(window(run(0, 20, 12)))).toEqual({
    status: "raining",
    intensity: "heavy",
    rainStartAt: null,
    rainEndAt: at(21),
    forecastUntil: at(60),
  });
});
test.each([
  [0.0999, "dry"],
  [0.1, "light"],
  [0.9999, "light"],
  [1.0, "moderate"],
  [9.9999, "moderate"],
  [10.0, "heavy"],
])("threshold and intensity boundary %f", (value, expected) => {
  const data = rainForecastOf(window({ 5: value }));
  expect(data.intensity).toBe(expected === "dry" ? null : expected);
});
test("a dry gap shorter than 5 minutes keeps one event; 5 minutes splits it", () => {
  // rain 5-9, dry 10-13 (4 minutes), rain 14-16: merged, ends after 16.
  const merged = rainForecastOf(
    window({ ...run(5, 9, 0.5), ...run(14, 16, 5) }),
  );
  expect(merged).toMatchObject({
    intensity: "moderate",
    rainStartAt: at(5),
    rainEndAt: at(17),
  });
  // dry 10-14 (5 minutes): the first event ends at 10.
  const split = rainForecastOf(
    window({ ...run(5, 9, 0.5), ...run(15, 16, 5) }),
  );
  expect(split).toMatchObject({
    intensity: "light",
    rainStartAt: at(5),
    rainEndAt: at(10),
  });
});
test("the end is unknown (null) when 5 dry minutes cannot be confirmed in the window", () => {
  // rain 55-56, dry 57-59 = only 3 minutes confirmed.
  expect(rainForecastOf(window(run(55, 56, 0.5)))).toMatchObject({
    rainStartAt: at(55),
    rainEndAt: null,
  });
  // rain until the end of the window.
  expect(rainForecastOf(window(run(40, 59, 0.5)))).toMatchObject({
    rainEndAt: null,
  });
  // exactly 5 dry minutes at the end are confirmed.
  expect(rainForecastOf(window(run(50, 54, 0.5)))).toMatchObject({
    rainEndAt: at(55),
  });
});
test("a dry first minute inside a short gap is dry; the next resumption is the start", () => {
  const data = rainForecastOf(window(run(2, 4, 0.5)));
  expect(data).toMatchObject({ status: "dry", rainStartAt: at(2) });
});
test("Domain Data validates and rejects extra properties", () => {
  expect(validRainForecastData(rainForecastOf(window()))).toBe(true);
  expect(validRainForecastData({ ...rainForecastOf(window()), x: 1 })).toBe(
    false,
  );
});

test("parseInstant accepts Z and numeric offsets and rejects impossible dates", () => {
  const ms = Date.parse("2026-10-21T13:20:00Z");
  for (const text of [
    "2026-10-21T13:20:00Z",
    "2026-10-21T13:20:00.000Z",
    "2026-10-21T13:20:00+00:00",
    "2026-10-21T13:20:00+0000",
    "2026-10-21T22:20:00+09:00",
  ])
    expect(parseInstant(text)).toBe(ms);
  for (const text of [
    "2026-02-30T00:00:00Z",
    "2026-10-21T25:00:00Z",
    "2026-10-21 13:20:00Z",
    "2026-10-21T13:20:00",
    "",
    null,
    123,
  ])
    expect(parseInstant(text)).toBeNull();
});
test("slotsOf reads only the 1m timeline and checks structure, not slot times or values", () => {
  expect(slotsOf(body([0, 0.2]))?.map((s) => s.value)).toEqual([0, 0.2]);
  expect(slotsOf(body([0], origin, "5m"))).toBeNull();
  expect(slotsOf(body([0], origin + 34_000))).toHaveLength(1); // judged by requiredWindow
  for (const bad of [null, [], {}, { data: {} }, { data: { timelines: {} } }])
    expect(slotsOf(bad)).toBeNull();
});

const slots = (n: number, value: unknown = 0, startMs = origin): Slot[] =>
  slotsOf(
    body(
      Array.from({ length: n }, () => value),
      startMs,
    ),
  )!;
test("requiredWindow starts at the next whole minute and needs 60 consecutive slots", () => {
  // Exactly on the minute: that minute.
  expect(requiredWindow(slots(66), origin)).toMatchObject({
    ok: true,
    originMs: origin,
  });
  // Not on the minute: the next one.
  expect(requiredWindow(slots(66), origin + 1)).toMatchObject({
    ok: true,
    originMs: origin + MIN,
  });
  // Enough slots remain from minute 6, not from minute 7 (66 slots in total).
  expect(requiredWindow(slots(66), origin + 6 * MIN).ok).toBe(true);
  expect(requiredWindow(slots(66), origin + 7 * MIN)).toEqual({
    ok: false,
    reason: "stale_data",
  });
  expect(requiredWindow(slots(59), origin)).toEqual({
    ok: false,
    reason: "stale_data",
  });
  expect(requiredWindow([], origin)).toEqual({
    ok: false,
    reason: "stale_data",
  });
});
test.each([null, undefined, "0.2", Number.NaN, Infinity, -0.1])(
  "an invalid required value %s fails the whole forecast (no 0 substitution)",
  (value) => {
    const values: unknown[] = Array.from({ length: 66 }, () => 0);
    values[30] = value;
    expect(requiredWindow(slotsOf(body(values))!, origin)).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  },
);
test("gaps, duplicates and reversed slots are invalid; extra slots are ignored", () => {
  const good = slotsOf(body(Array.from({ length: 66 }, () => 0)))!;
  const gap = good.filter((_, i) => i !== 20);
  expect(requiredWindow(gap, origin)).toEqual({
    ok: false,
    reason: "invalid_response",
  });
  const duplicate = [...good.slice(0, 21), good[20]!, ...good.slice(21)];
  expect(requiredWindow(duplicate, origin).ok).toBe(false);
  const reversed = [
    ...good.slice(0, 10),
    good[11]!,
    good[10]!,
    ...good.slice(12),
  ];
  expect(requiredWindow(reversed, origin).ok).toBe(false);
  // A broken value after the required 60 slots is ignored (21.5: extras).
  const values: unknown[] = Array.from({ length: 66 }, () => 0);
  values[63] = "bad";
  expect(requiredWindow(slotsOf(body(values))!, origin).ok).toBe(true);
});

// ---- Extra slots are not adopted (21.5); the adopted 60 are strict ----
const times = (n: number, startMs = origin) =>
  Array.from({ length: n }, (_, i) =>
    new Date(startMs + i * MIN).toISOString(),
  );
const raw = (
  startTimes: unknown[],
  values: unknown[] = startTimes.map(() => 0),
): Slot[] =>
  startTimes.map((startTime, i) => ({ startTime, value: values[i] }));

test("an invalid time or value only in trailing extra slots does not reject a valid 60-slot window", () => {
  const t: unknown[] = times(66);
  t[61] = "garbage";
  t[62] = null;
  t[63] = new Date(origin + 63 * MIN + 34_000).toISOString(); // off the grid
  t[64] = t[10]; // duplicate of an adopted slot's time
  t[65] = "2026-02-30T00:00:00Z";
  const v: unknown[] = t.map(() => 0);
  v[62] = "bad";
  v[65] = Number.NaN;
  expect(requiredWindow(raw(t, v), origin)).toMatchObject({
    ok: true,
    originMs: origin,
  });
});
test("an invalid time in leading (past) extra slots does not reject the window either", () => {
  const t: unknown[] = [
    "garbage",
    new Date(origin - 2 * MIN + 5000).toISOString(),
    ...times(60),
  ];
  expect(requiredWindow(raw(t), origin)).toMatchObject({ ok: true });
});
test("inside the adopted 60 slots a bad time, gap, duplicate or reversal fails closed", () => {
  const base = times(66);
  for (const index of [0, 1, 30, 59]) {
    const bad: unknown[] = [...base];
    bad[index] = "garbage";
    expect(requiredWindow(raw(bad), origin)).toEqual({
      ok: false,
      reason: "invalid_response",
    });
    const dup: unknown[] = [...base];
    dup[index] = index === 0 ? base[1] : base[index - 1];
    expect(requiredWindow(raw(dup), origin).ok).toBe(false);
  }
  const reversed: unknown[] = [...base];
  [reversed[20], reversed[21]] = [reversed[21], reversed[20]];
  expect(requiredWindow(raw(reversed), origin).ok).toBe(false);
  expect(requiredWindow(raw(base.filter((_, i) => i !== 40)), origin).ok).toBe(
    false,
  );
});
test("inside the adopted 60 slots a bad intensity fails closed", () => {
  for (const bad of [null, undefined, "0.2", Number.NaN, Infinity, -1]) {
    const v: unknown[] = times(66).map(() => 0);
    v[59] = bad; // the last adopted slot
    expect(requiredWindow(raw(times(66), v), origin)).toEqual({
      ok: false,
      reason: "invalid_response",
    });
  }
});
test("when the window cannot be located the forecast fails closed", () => {
  // No usable slot at all (e.g. a timeline that is off the minute grid).
  const offGrid = times(66, origin + 34_000);
  expect(requiredWindow(raw(offGrid), origin)).toEqual({
    ok: false,
    reason: "invalid_response",
  });
  // The origin slot itself is unusable: the next usable slot is not the origin.
  const t: unknown[] = times(66);
  t[0] = "garbage";
  expect(requiredWindow(raw(t), origin)).toEqual({
    ok: false,
    reason: "invalid_response",
  });
  // Too few slots from the origin, or every slot is in the past.
  expect(requiredWindow(raw(times(59)), origin).ok).toBe(false);
  expect(requiredWindow(raw(times(66)), origin + 66 * MIN)).toEqual({
    ok: false,
    reason: "stale_data",
  });
});
test("a slot that is extra at the Request start becomes adopted at adoption time (two stages)", () => {
  // Slot 62 is bad: it is outside the window from the Request start (minute 0)
  // but inside the window from minute 3 (slots 3-62).
  const t: unknown[] = times(66);
  t[62] = "garbage";
  const slotsWithBadExtra = raw(t);
  expect(requiredWindow(slotsWithBadExtra, origin).ok).toBe(true);
  expect(requiredWindow(slotsWithBadExtra, origin + 3 * MIN)).toEqual({
    ok: false,
    reason: "invalid_response",
  });
});
