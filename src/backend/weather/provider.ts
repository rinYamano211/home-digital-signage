import type { Logger } from "pino";
import type {
  AcquireContext,
  AcquireResult,
  MultiHttpProvider,
} from "../acquisition/coordinator.js";
import { ABSOLUTE_MAX_BODY_BYTES } from "../http/outcome.js";
import type { StateKey } from "../storage/published-state-repository.js";
import { tokyoDate, tokyoDayStart } from "../schedule/jst.js";
import {
  currentWeather,
  forecastBody,
  forecastUrl,
  hourlyWeather,
  weeklyWeather,
  type Extraction,
  type WeatherKind,
  type WeatherLocation,
} from "./open-meteo.js";
import {
  HOUR_MS,
  HOURLY_MAX,
  HOURLY_REQUIRED,
  validCurrentWeatherData,
  validHourlyWeatherData,
  validWeeklyWeatherData,
  WEEKLY_MAX,
  WEEKLY_REQUIRED,
} from "./weather-data.js";

/** Period / TTL (technology-stack 19.4 / 20.1 / 22.1). */
export const CURRENT_WEATHER_PERIOD_MS = 15 * 60_000;
export const CURRENT_WEATHER_TTL_MS = 2 * HOUR_MS;
export const HOURLY_WEATHER_PERIOD_MS = 30 * 60_000;
export const HOURLY_WEATHER_TTL_MS = 2 * HOUR_MS;
export const WEEKLY_WEATHER_PERIOD_MS = 6 * HOUR_MS;
export const WEEKLY_WEATHER_TTL_MS = 12 * HOUR_MS;
/** CurrentWeather freshness at adoption (19.3 / 19.4). */
export const CURRENT_PAST_TOLERANCE_MS = 30 * 60_000;
export const CURRENT_FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Fixed log classification (16.6). Never the location, URL or any Body. */
export type WeatherFailureReason =
  | "rate_limited"
  | "server_error"
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_response"
  | "stale_data";
type WeatherLogger = Pick<Logger, "debug" | "warn">;
type WeatherStateKey = Extract<
  StateKey,
  "currentWeather" | "hourlyWeather" | "weeklyWeather"
>;

/** What a kind adds to the shared attempt: the Domain Data at adoption. */
type Adopt = (
  body: Record<string, unknown>,
  startedAtMs: number,
) =>
  | { ok: true; data: Record<string, unknown>; count: number }
  | { ok: false; reason: "invalid_response" | "stale_data" };

interface Definition {
  readonly stateKey: WeatherStateKey;
  readonly kind: WeatherKind;
  readonly periodMs: number;
  readonly ttlMs: number;
  readonly adopt: Adopt;
}

/** Next full hour; an exact hour is itself (20.2). JST hours are UTC hours. */
const nextHour = (ms: number) => Math.ceil(ms / HOUR_MS) * HOUR_MS;
const extractionFailure = (
  result: Extraction<unknown> | null,
): "invalid_response" | "stale_data" =>
  result !== null && !result.ok && result.reason === "missing"
    ? "stale_data"
    : "invalid_response";

const adoptCurrent: Adopt = (body) => {
  const data = currentWeather(body);
  if (!data || !validCurrentWeatherData(data))
    return { ok: false, reason: "invalid_response" };
  // Freshness against the adoption time, not the start (19.3).
  const now = Date.now();
  const validAt = Date.parse(data.validAt);
  if (
    validAt < now - CURRENT_PAST_TOLERANCE_MS ||
    validAt > now + CURRENT_FUTURE_TOLERANCE_MS
  )
    return { ok: false, reason: "stale_data" };
  return { ok: true, data, count: 1 };
};

const adoptHourly: Adopt = (body, startedAtMs) => {
  // Stage 1: up to 36 slots from the start's next hour (20.2 / 20.3).
  const start = nextHour(startedAtMs);
  const result = hourlyWeather(body, start, HOURLY_REQUIRED, HOURLY_MAX);
  if (!result?.ok) return { ok: false, reason: extractionFailure(result) };
  // Stage 2: 24 slots from the adoption time's next hour. Slots that became
  // past are kept; the Frontend selects from the current time (20.5).
  const offset = (nextHour(Date.now()) - start) / HOUR_MS;
  if (offset < 0 || offset + HOURLY_REQUIRED > result.items.length)
    return { ok: false, reason: "stale_data" };
  const data = { hours: result.items };
  if (!validHourlyWeatherData(data))
    return { ok: false, reason: "invalid_response" };
  return { ok: true, data, count: result.items.length };
};

const adoptWeekly: Adopt = (body, startedAtMs) => {
  // Stage 1: 7 required + 2 spare days from the start's JST date (22.3 / 22.4).
  const startDate = tokyoDate(startedAtMs);
  const result = weeklyWeather(body, startDate, WEEKLY_REQUIRED, WEEKLY_MAX);
  if (!result?.ok) return { ok: false, reason: extractionFailure(result) };
  // Stage 2: 7 days from the adoption date.
  const offset =
    (tokyoDayStart(tokyoDate(Date.now()))! - tokyoDayStart(startDate)!) /
    86_400_000;
  if (offset < 0 || offset + WEEKLY_REQUIRED > result.items.length)
    return { ok: false, reason: "stale_data" };
  const data = { days: result.items };
  if (!validWeeklyWeatherData(data))
    return { ok: false, reason: "invalid_response" };
  return { ok: true, data, count: result.items.length };
};

const DEFINITIONS: readonly Definition[] = [
  {
    stateKey: "currentWeather",
    kind: "current",
    periodMs: CURRENT_WEATHER_PERIOD_MS,
    ttlMs: CURRENT_WEATHER_TTL_MS,
    adopt: adoptCurrent,
  },
  {
    stateKey: "hourlyWeather",
    kind: "hourly",
    periodMs: HOURLY_WEATHER_PERIOD_MS,
    ttlMs: HOURLY_WEATHER_TTL_MS,
    adopt: adoptHourly,
  },
  {
    stateKey: "weeklyWeather",
    kind: "weekly",
    periodMs: WEEKLY_WEATHER_PERIOD_MS,
    ttlMs: WEEKLY_WEATHER_TTL_MS,
    adopt: adoptWeekly,
  },
];

function createProvider(
  definition: Definition,
  location: WeatherLocation,
  logger: WeatherLogger,
): MultiHttpProvider {
  const { stateKey, kind, periodMs, ttlMs, adopt } = definition;
  const url = forecastUrl(location, kind); // contains the location: never logged

  const fail = (
    signal: AbortSignal,
    reason: WeatherFailureReason,
    http?: { status: number; retryAfter?: string },
  ): AcquireResult => {
    // An aborted attempt is not a Provider failure; it is not logged.
    if (!signal.aborted)
      logger.warn(
        {
          event: "weather_acquisition_failed",
          stateKey,
          reason,
          ...(http ? { httpStatus: http.status } : {}),
        },
        "Weather acquisition failed",
      );
    return {
      kind: "failure",
      ...(http ? { httpStatus: http.status } : {}),
      ...(http?.retryAfter !== undefined
        ? { retryAfter: http.retryAfter }
        : {}),
    };
  };

  return Object.freeze({
    stateKey,
    periodMs,
    quota: false,
    // No nextPeriodMs: the Frontend re-selects hours / days (16.6).
    async acquire(ctx: AcquireContext): Promise<AcquireResult> {
      const startedAtMs = Date.parse(ctx.startedAt);
      if (!Number.isFinite(startedAtMs)) return { kind: "failure" };
      const outcome = await ctx.http({
        url,
        maxBodyBytes: ABSOLUTE_MAX_BODY_BYTES,
      });
      // Shutdown after the HTTP: no log, and the Coordinator saves nothing.
      if (ctx.signal.aborted) return { kind: "failure" };
      switch (outcome.kind) {
        case "response":
          break;
        case "timeout":
          return fail(ctx.signal, "timeout");
        case "body_too_large":
          return fail(ctx.signal, "invalid_response", outcome.http);
        default:
          return fail(ctx.signal, "network_error", outcome.http);
      }
      const { status } = outcome.http;
      if (status === 429) return fail(ctx.signal, "rate_limited", outcome.http);
      if (status >= 500) return fail(ctx.signal, "server_error", outcome.http);
      // Other statuses, including 400 for invalid parameters. The error
      // `reason` in the Body is never read or logged.
      if (status !== 200) return fail(ctx.signal, "http_error", outcome.http);
      const body = forecastBody(outcome.body);
      if (!body) return fail(ctx.signal, "invalid_response");
      // Checked again just before adoption (16.6).
      if (ctx.signal.aborted) return { kind: "failure" };
      const adopted = adopt(body, startedAtMs);
      if (!adopted.ok) return fail(ctx.signal, adopted.reason);
      // Never return or log a success for an aborted attempt (16.6).
      if (ctx.signal.aborted) return { kind: "failure" };
      const completedAtMs = Date.now();
      logger.debug(
        { event: "weather_acquired", stateKey, count: adopted.count },
        "Weather acquired",
      );
      return {
        kind: "success",
        data: adopted.data,
        expiresAt: new Date(completedAtMs + ttlMs).toISOString(),
      };
    },
  } satisfies MultiHttpProvider);
}

/** The three Open-Meteo Providers (Issue #9), each with its own Request. */
export function createWeatherProviders(
  location: WeatherLocation,
  logger: WeatherLogger,
): MultiHttpProvider[] {
  return DEFINITIONS.map((d) => createProvider(d, location, logger));
}
