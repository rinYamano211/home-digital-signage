import type { Logger } from "pino";
import type {
  ParseContext,
  StateProvider,
} from "../acquisition/coordinator.js";
import type { HttpOutcome } from "../http/outcome.js";
import type { WeatherLocation } from "./open-meteo.js";
import {
  rainForecastOf,
  requiredWindow,
  slotsOf,
  validRainForecastData,
} from "./rain-forecast.js";

/** Tomorrow.io RainForecast Provider (technology-stack 16.1 / 21.1 / 21.9).
 * Quota target: one fixed POST per Gate reservation. The API key is in the
 * Request URL (the only documented method), so the HTTP configuration is
 * never logged, returned or put into Domain Data.
 */
export const RAIN_FORECAST_PERIOD_MS = 5 * 60_000;
export const RAIN_FORECAST_TTL_MS = 30 * 60_000;
const ENDPOINT = "https://api.tomorrow.io/v4/timelines";
const MAX_BODY_BYTES = 262_144;
/** Key characters allowed in the URL (checked again here, on top of encoding). */
export const API_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

type RainFailureReason =
  | "rate_limited"
  | "server_error"
  | "http_error"
  | "network_error"
  | "timeout"
  | "invalid_response"
  | "stale_data";
type RainLogger = Pick<Logger, "debug" | "warn">;

export function createRainForecastProvider(options: {
  location: WeatherLocation;
  apiKey: string;
  logger: RainLogger;
}): StateProvider {
  const { location, apiKey, logger } = options;
  if (!API_KEY_PATTERN.test(apiKey)) throw new TypeError("Invalid API key");
  const http = Object.freeze({
    url: `${ENDPOINT}?apikey=${encodeURIComponent(apiKey)}`,
    method: "POST" as const,
    headers: Object.freeze({
      "Content-Type": "application/json",
      Accept: "application/json",
    }),
    // The location is in the Body only; startTime / endTime are relative to
    // the Provider's "now" (21.1).
    body: JSON.stringify({
      location: `${location.latitude}, ${location.longitude}`,
      fields: ["rainIntensity"],
      units: "metric",
      timesteps: ["1m"],
      startTime: "now",
      endTime: "nowPlus65m",
    }),
    maxBodyBytes: MAX_BODY_BYTES,
  });
  const fail = (
    reason: RainFailureReason,
    status?: { status: number; retryAfter?: string },
  ): { kind: "failure" } => {
    logger.warn(
      {
        event: "weather_acquisition_failed",
        stateKey: "rainForecast",
        reason,
        ...(status ? { httpStatus: status.status } : {}),
      },
      "Weather acquisition failed",
    );
    return { kind: "failure" };
  };
  return Object.freeze({
    stateKey: "rainForecast",
    periodMs: RAIN_FORECAST_PERIOD_MS,
    quota: true,
    http,
    parse(outcome: HttpOutcome, context?: ParseContext) {
      switch (outcome.kind) {
        case "response":
          break;
        case "timeout":
          return fail("timeout");
        case "aborted":
          return { kind: "failure" as const }; // not a Provider failure: no log
        case "body_too_large":
        case "body_error":
          return fail("invalid_response", outcome.http);
        default:
          return fail("network_error", outcome.http);
      }
      const { status } = outcome.http;
      if (status === 429) return fail("rate_limited", outcome.http);
      if (status >= 500) return fail("server_error", outcome.http);
      // Includes 400 / 401 / 403; the error Body is never read or logged.
      if (status !== 200) return fail("http_error", outcome.http);
      if (!context) return fail("invalid_response");
      const requestStartedMs = Date.parse(context.requestStartedAt);
      if (!Number.isFinite(requestStartedMs)) return fail("invalid_response");
      let body: unknown;
      try {
        body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(outcome.body),
        );
      } catch {
        return fail("invalid_response");
      }
      const slots = slotsOf(body);
      if (!slots) return fail("invalid_response");
      // Stage 1: the span required from the Request start (21.5).
      const first = requiredWindow(slots, requestStartedMs);
      if (!first.ok) return fail(first.reason);
      // Stage 2, just before adoption: the span required from now.
      const adoptedAtMs = context.now();
      if (!Number.isFinite(adoptedAtMs)) return fail("invalid_response");
      const second = requiredWindow(slots, adoptedAtMs);
      if (!second.ok) return fail(second.reason);
      const data = rainForecastOf(second);
      if (!validRainForecastData(data)) return fail("invalid_response");
      logger.debug(
        { event: "weather_acquired", stateKey: "rainForecast", count: 60 },
        "Weather acquired",
      );
      return {
        kind: "success" as const,
        data: { ...data },
        expiresAt: new Date(adoptedAtMs + RAIN_FORECAST_TTL_MS).toISOString(),
      };
    },
  } satisfies StateProvider);
}
