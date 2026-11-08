import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { addDays, tokyoDayStart } from "../schedule/jst.js";

/** Weather Domain Data (technology-stack 19.2 / 20.1 / 22.2). */
const Finite = Type.Number();
const Code = Type.Integer();
const Probability = Type.Number({ minimum: 0, maximum: 100 });
/** `Date#toISOString()` only (16.6), e.g. 2026-11-08T06:00:00.000Z. */
const UtcInstant = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
});
const DateString = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

export const CurrentWeatherDataSchema = Type.Object(
  {
    temperatureC: Finite,
    weatherCode: Code,
    isDay: Type.Boolean(),
    validAt: UtcInstant,
  },
  { additionalProperties: false },
);
export const HourlyWeatherDataSchema = Type.Object(
  {
    hours: Type.Array(
      Type.Object(
        {
          validAt: UtcInstant,
          temperatureC: Finite,
          weatherCode: Code,
          precipitationProbability: Probability,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const WeeklyWeatherDataSchema = Type.Object(
  {
    days: Type.Array(
      Type.Object(
        {
          date: DateString,
          weatherCode: Code,
          temperatureMaxC: Finite,
          temperatureMinC: Finite,
          precipitationProbability: Probability,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type CurrentWeatherData = Static<typeof CurrentWeatherDataSchema>;
export type HourlyWeatherData = Static<typeof HourlyWeatherDataSchema>;
export type HourlyWeatherItem = HourlyWeatherData["hours"][number];
export type WeeklyWeatherData = Static<typeof WeeklyWeatherDataSchema>;
export type WeeklyWeatherItem = WeeklyWeatherData["days"][number];

/** Required and maximum ranges (20.1 / 22.3). */
export const HOURLY_REQUIRED = 24;
export const HOURLY_MAX = 36;
export const WEEKLY_REQUIRED = 7;
export const WEEKLY_MAX = 9;
export const HOUR_MS = 3_600_000;

const instant = (value: string) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value
    ? ms
    : null;
};

/** Schema plus Semantic Validation (19.3). Freshness is checked separately. */
export function validCurrentWeatherData(
  value: unknown,
): value is CurrentWeatherData {
  return (
    Value.Check(CurrentWeatherDataSchema, value) &&
    Number.isSafeInteger(value.weatherCode) &&
    instant(value.validAt) !== null
  );
}

/** Schema plus Semantic Validation (20.1 / 20.3): 24-36 consecutive hours. */
export function validHourlyWeatherData(
  value: unknown,
): value is HourlyWeatherData {
  if (!Value.Check(HourlyWeatherDataSchema, value)) return false;
  const { hours } = value;
  if (hours.length < HOURLY_REQUIRED || hours.length > HOURLY_MAX) return false;
  let previous: number | null = null;
  for (const hour of hours) {
    const at = instant(hour.validAt);
    if (at === null || at % HOUR_MS !== 0) return false;
    if (!Number.isSafeInteger(hour.weatherCode)) return false;
    if (previous !== null && at !== previous + HOUR_MS) return false;
    previous = at;
  }
  return true;
}

/** Schema plus Semantic Validation (22.2 / 22.3): 7-9 consecutive days. */
export function validWeeklyWeatherData(
  value: unknown,
): value is WeeklyWeatherData {
  if (!Value.Check(WeeklyWeatherDataSchema, value)) return false;
  const { days } = value;
  if (days.length < WEEKLY_REQUIRED || days.length > WEEKLY_MAX) return false;
  let previous: string | null = null;
  for (const day of days) {
    if (tokyoDayStart(day.date) === null) return false;
    if (!Number.isSafeInteger(day.weatherCode)) return false;
    if (!(day.temperatureMinC <= day.temperatureMaxC)) return false;
    if (previous !== null && day.date !== addDays(previous, 1)) return false;
    previous = day.date;
  }
  return true;
}
