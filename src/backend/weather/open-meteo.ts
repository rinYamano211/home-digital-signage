import { tokyoDayStart } from "../schedule/jst.js";
import type {
  CurrentWeatherData,
  HourlyWeatherItem,
  WeeklyWeatherItem,
} from "./weather-data.js";

/** Open-Meteo Forecast API (technology-stack 16.6). No API key. */
export const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
/** Asia/Tokyo has no daylight saving time: always UTC+9. */
const JST_OFFSET_SECONDS = 32_400;

export interface WeatherLocation {
  readonly latitude: number;
  readonly longitude: number;
}
export type WeatherKind = "current" | "hourly" | "weekly";

const PARAMETERS: Record<WeatherKind, Record<string, string>> = {
  current: { current: "temperature_2m,weather_code,is_day" },
  hourly: {
    hourly: "temperature_2m,weather_code,precipitation_probability",
    forecast_days: "3",
  },
  weekly: {
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    forecast_days: "9",
  },
};

/** One independent Request per State (16.6). The URL holds the home
 * location: it must never be logged.
 */
export function forecastUrl(
  location: WeatherLocation,
  kind: WeatherKind,
): string {
  const query = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    timezone: "Asia/Tokyo",
    ...PARAMETERS[kind],
  });
  return `${OPEN_METEO_FORECAST_URL}?${query.toString()}`;
}

type Json = Record<string, unknown>;
const object = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const code = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v);
const probability = (v: unknown): v is number =>
  finite(v) && v >= 0 && v <= 100;

const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/** A JST local time without offset (e.g. 2026-11-08T15:00) as epoch ms, or
 * null for a malformed or non-existent time.
 */
export function jstLocalTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = LOCAL.exec(value);
  if (!match) return null;
  const day = tokyoDayStart(match[1]!);
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (day === null || hour > 23 || minute > 59) return null;
  return day + (hour * 60 + minute) * 60_000;
}

/** Parses the Body and checks the fixed JST offset (16.6). The grid point
 * latitude / longitude in the response are never read.
 */
export function forecastBody(body: Uint8Array): Json | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (!object(value) || value.utc_offset_seconds !== JST_OFFSET_SECONDS)
    return null;
  return value;
}

/** Current block (19.3). Freshness is the caller's adoption check. */
export function currentWeather(body: Json): CurrentWeatherData | null {
  const current = body.current;
  if (!object(current)) return null;
  const validAt = jstLocalTime(current.time);
  const interval = current.interval;
  if (
    validAt === null ||
    !(typeof interval === "number" && Number.isSafeInteger(interval)) ||
    interval <= 0 ||
    !finite(current.temperature_2m) ||
    !code(current.weather_code) ||
    (current.is_day !== 0 && current.is_day !== 1)
  )
    return null;
  return {
    temperatureC: current.temperature_2m,
    weatherCode: current.weather_code,
    isDay: current.is_day === 1,
    validAt: new Date(validAt).toISOString(),
  };
}

/** First-stage structure check (20.3 / 22.3): every array exists and all
 * have the same length. Null is a structural failure of the whole State.
 */
function arrays(block: unknown, names: readonly string[]): unknown[][] | null {
  if (!object(block)) return null;
  const result: unknown[][] = [];
  for (const name of names) {
    const value = block[name];
    if (!Array.isArray(value)) return null;
    result.push(value);
  }
  return result.every((a) => a.length === result[0]!.length) ? result : null;
}

/** Range extraction result: `missing` means the start or the required range
 * is absent (stale_data); `invalid` means a broken value inside it.
 */
export type Extraction<T> =
  { ok: true; items: T[] } | { ok: false; reason: "invalid" | "missing" };

/** Up to `max` consecutive valid entries from `start`; at least `required`.
 * Entries before `start` are not used. The optional range stops at the first
 * anomaly (20.3 / 22.3); a gap or anomaly inside the required range fails the
 * whole State. Entries are never filled from an earlier Cache.
 */
function consecutive<T>(
  length: number,
  index: (i: number) => number | null,
  item: (i: number) => T | null,
  start: number,
  next: (at: number) => number,
  required: number,
  max: number,
): Extraction<T> {
  let first = -1;
  let malformed = false;
  for (let i = 0; i < length; i++) {
    const at = index(i);
    if (at === start) {
      first = i;
      break;
    }
    if (at === null) malformed = true;
  }
  // A start hidden behind malformed times is a broken response, not stale.
  if (first < 0)
    return { ok: false, reason: malformed ? "invalid" : "missing" };
  const items: T[] = [];
  let expected = start;
  for (let i = first; i < length && items.length < max; i++) {
    const value = index(i) === expected ? item(i) : null;
    if (value === null) {
      if (items.length < required) return { ok: false, reason: "invalid" };
      break;
    }
    items.push(value);
    expected = next(expected);
  }
  return items.length < required
    ? { ok: false, reason: "missing" }
    : { ok: true, items };
}

const HOUR_MS = 3_600_000;

/** Hourly slots from `startHourMs` (20.2 / 20.3). Null: structural failure. */
export function hourlyWeather(
  body: Json,
  startHourMs: number,
  required: number,
  max: number,
): Extraction<HourlyWeatherItem> | null {
  const columns = arrays(body.hourly, [
    "time",
    "temperature_2m",
    "weather_code",
    "precipitation_probability",
  ]);
  if (!columns) return null;
  const [time, temperature, weatherCode, precipitation] = columns as [
    unknown[],
    unknown[],
    unknown[],
    unknown[],
  ];
  return consecutive<HourlyWeatherItem>(
    time.length,
    (i) => jstLocalTime(time[i]),
    (i) => {
      const t = temperature[i];
      const c = weatherCode[i];
      const p = precipitation[i];
      if (!finite(t) || !code(c) || !probability(p)) return null;
      return {
        validAt: new Date(jstLocalTime(time[i])!).toISOString(),
        temperatureC: t,
        weatherCode: c,
        precipitationProbability: p,
      };
    },
    startHourMs,
    (at) => at + HOUR_MS,
    required,
    max,
  );
}

/** Daily entries from the JST date `startDate` (22.3 / 22.4). Null:
 * structural failure.
 */
export function weeklyWeather(
  body: Json,
  startDate: string,
  required: number,
  max: number,
): Extraction<WeeklyWeatherItem> | null {
  const columns = arrays(body.daily, [
    "time",
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_probability_max",
  ]);
  if (!columns) return null;
  const [time, weatherCode, maxC, minC, precipitation] = columns as [
    unknown[],
    unknown[],
    unknown[],
    unknown[],
    unknown[],
  ];
  const start = tokyoDayStart(startDate);
  if (start === null) return { ok: false, reason: "missing" };
  return consecutive<WeeklyWeatherItem>(
    time.length,
    (i) => (typeof time[i] === "string" ? tokyoDayStart(time[i]) : null),
    (i) => {
      const c = weatherCode[i];
      const hi = maxC[i];
      const lo = minC[i];
      const p = precipitation[i];
      if (!code(c) || !finite(hi) || !finite(lo) || !probability(p))
        return null;
      if (!(lo <= hi)) return null;
      return {
        date: time[i] as string,
        weatherCode: c,
        temperatureMaxC: hi,
        temperatureMinC: lo,
        precipitationProbability: p,
      };
    },
    start,
    (at) => at + 86_400_000,
    required,
    max,
  );
}
