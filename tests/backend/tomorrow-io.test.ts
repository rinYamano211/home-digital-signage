// Tomorrow.io RainForecast Provider (technology-stack 21.9): Request, response
// handling, failure classification, and that nothing secret is ever logged.
import { expect, test, vi } from "vitest";
import {
  API_KEY_PATTERN,
  RAIN_FORECAST_PERIOD_MS,
  RAIN_FORECAST_TTL_MS,
  createRainForecastProvider,
} from "../../src/backend/weather/tomorrow-io.js";
import { rainForecastProvider } from "../../src/backend/weather/tomorrow-setup.js";
import { SecretError } from "../../src/backend/config/secrets.js";
import type { BackendConfig } from "../../src/backend/config/schema.js";
import type { HttpOutcome } from "../../src/backend/http/outcome.js";
import { validRainForecastData } from "../../src/backend/weather/rain-forecast.js";

const KEY = "test_key-ABCDEFGH12345678";
const location = { latitude: 35.123456, longitude: 139.654321 };
const startMs = Date.parse("2026-11-09T12:00:00Z");
const MIN = 60_000;
const logger = () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() });
const make = (log = logger()) => ({
  log,
  provider: createRainForecastProvider({ location, apiKey: KEY, logger: log }),
});
const response = (
  json: unknown,
  status = 200,
  retryAfter?: string,
): HttpOutcome => ({
  kind: "response",
  http: { status, ...(retryAfter !== undefined ? { retryAfter } : {}) },
  body: new TextEncoder().encode(
    typeof json === "string" ? json : JSON.stringify(json),
  ),
});
const timeline = (n = 66, rain: Record<number, number> = {}) => ({
  data: {
    timelines: [
      {
        timestep: "1m",
        intervals: Array.from({ length: n }, (_, i) => ({
          startTime: new Date(startMs + i * MIN).toISOString(),
          values: { rainIntensity: rain[i] ?? 0 },
        })),
      },
    ],
  },
});
const context = (nowMs = startMs + 3000) => ({
  requestStartedAt: new Date(startMs + 1000).toISOString(),
  now: () => nowMs,
});
const secretsIn = (calls: unknown[][]) => {
  const text = JSON.stringify(calls);
  return [KEY, "35.123456", "139.654321", "apikey", "api.tomorrow.io"].filter(
    (s) => text.includes(s),
  );
};

test("the Request is one fixed POST: key in the URL, location only in the Body", () => {
  const { provider } = make();
  expect(provider).toMatchObject({
    stateKey: "rainForecast",
    quota: true,
    periodMs: RAIN_FORECAST_PERIOD_MS,
  });
  expect(RAIN_FORECAST_PERIOD_MS).toBe(5 * MIN);
  expect(provider.http.method).toBe("POST");
  expect(provider.http.url).toBe(
    `https://api.tomorrow.io/v4/timelines?apikey=${KEY}`,
  );
  expect(provider.http.headers).toEqual({
    "Content-Type": "application/json",
    Accept: "application/json",
  });
  expect(JSON.parse(provider.http.body!)).toEqual({
    location: "35.123456, 139.654321",
    fields: ["rainIntensity"],
    units: "metric",
    timesteps: ["1m"],
    startTime: "now",
    endTime: "nowPlus65m",
  });
  expect(provider.http.url).not.toContain("35.123456");
  expect(Object.isFrozen(provider.http)).toBe(true);
});
test.each([
  "",
  "short",
  "has space 12345678",
  "a/b?c=12345678",
  "é".repeat(10),
])(
  "an unusable API key %j is rejected before any Request is built",
  (apiKey) => {
    expect(API_KEY_PATTERN.test(apiKey)).toBe(false);
    expect(() =>
      createRainForecastProvider({ location, apiKey, logger: logger() }),
    ).toThrow(TypeError);
  },
);
test("a valid response becomes Domain Data with the 30-minute TTL from adoption", () => {
  const { provider, log } = make();
  const nowMs = startMs + 3000;
  const result = provider.parse(
    response(timeline(66, { 10: 0.5, 11: 0.5 })),
    context(nowMs),
  );
  expect(result).toEqual({
    kind: "success",
    data: {
      status: "dry",
      intensity: "light",
      rainStartAt: new Date(startMs + 10 * MIN).toISOString(),
      rainEndAt: new Date(startMs + 12 * MIN).toISOString(),
      forecastUntil: new Date(startMs + 61 * MIN).toISOString(),
    },
    expiresAt: new Date(nowMs + RAIN_FORECAST_TTL_MS).toISOString(),
  });
  if (result.kind === "success")
    expect(validRainForecastData(result.data)).toBe(true);
  expect(log.warn).not.toHaveBeenCalled();
});
test("the span is checked again at adoption time (stale_data)", () => {
  const { provider, log } = make();
  // 66 slots from the Request: still 60 from minute 6, not from minute 7.
  expect(
    provider.parse(response(timeline()), context(startMs + 5 * MIN + 1)).kind,
  ).toBe("success");
  expect(
    provider.parse(response(timeline()), context(startMs + 6 * MIN + 1)).kind,
  ).toBe("failure");
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "stale_data", stateKey: "rainForecast" }),
    expect.any(String),
  );
});
test.each([
  ["timeout", { kind: "timeout" } as HttpOutcome, "timeout"],
  ["network", { kind: "network_error" } as HttpOutcome, "network_error"],
  [
    "oversized body",
    { kind: "body_too_large", http: { status: 200 } } as HttpOutcome,
    "invalid_response",
  ],
  ["429", response({}, 429, "30"), "rate_limited"],
  ["503", response({}, 503), "server_error"],
  ["400", response({ message: KEY }, 400), "http_error"],
  ["401", response({}, 401), "http_error"],
  ["not JSON", response("<html>"), "invalid_response"],
  ["no timelines", response({ data: {} }), "invalid_response"],
  ["bad value", response(timeline(66, { 4: -1 })), "invalid_response"],
  ["too short", response(timeline(50)), "stale_data"],
])(
  "%s is a classified failure and nothing secret is logged",
  (_name, outcome, reason) => {
    const { provider, log } = make();
    expect(provider.parse(outcome, context())).toEqual({ kind: "failure" });
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        event: "weather_acquisition_failed",
        stateKey: "rainForecast",
        reason,
      }),
      expect.any(String),
    );
    expect(secretsIn(log.warn.mock.calls)).toEqual([]);
  },
);
test("an aborted Request is not a Provider failure and is not logged; a missing context fails", () => {
  const { provider, log } = make();
  expect(provider.parse({ kind: "aborted" }, context())).toEqual({
    kind: "failure",
  });
  expect(log.warn).not.toHaveBeenCalled();
  expect(provider.parse(response(timeline()))).toEqual({ kind: "failure" });
  expect(secretsIn(log.warn.mock.calls)).toEqual([]);
});

// ---- Startup wiring ----
const config = (withLocation = true) =>
  ({
    ...(withLocation ? { weatherLocation: location } : {}),
  }) as unknown as BackendConfig;
test("unset location: not registered, info only; unusable Secret: not registered, warn with a classification", async () => {
  const log = logger();
  const load = vi.fn();
  expect(await rainForecastProvider(config(false), log, load)).toBeNull();
  expect(load).not.toHaveBeenCalled(); // the Secret is not read without a location
  expect(log.info).toHaveBeenCalledWith(
    { event: "rain_forecast_provider_disabled", reason: "location_unset" },
    expect.any(String),
  );
  for (const reason of ["missing", "permission", "invalid_json"] as const) {
    const l = logger();
    expect(
      await rainForecastProvider(config(), l, async () => {
        throw new SecretError(reason);
      }),
    ).toBeNull();
    expect(l.warn).toHaveBeenCalledWith(
      { event: "rain_forecast_provider_disabled", reason },
      expect.any(String),
    );
  }
  for (const secret of [
    {},
    { tomorrowIoApiKey: 1 },
    { tomorrowIoApiKey: "short" },
    { tomorrowIoApiKey: "bad key with space 123" },
  ]) {
    const l = logger();
    expect(
      await rainForecastProvider(config(), l, async () => secret),
    ).toBeNull();
    expect(l.warn).toHaveBeenCalledWith(
      {
        event: "rain_forecast_provider_disabled",
        reason: "invalid_credentials",
      },
      expect.any(String),
    );
    expect(secretsIn(l.warn.mock.calls)).toEqual([]);
  }
});
test("a usable Secret and location register the Provider and log no secret", async () => {
  const log = logger();
  const provider = await rainForecastProvider(config(), log, async () => ({
    tomorrowIoApiKey: KEY,
  }));
  expect(provider?.stateKey).toBe("rainForecast");
  expect(provider?.quota).toBe(true);
  expect(log.info).toHaveBeenCalledExactlyOnceWith(
    { event: "rain_forecast_provider_enabled" },
    expect.any(String),
  );
  expect(secretsIn([...log.info.mock.calls, ...log.warn.mock.calls])).toEqual(
    [],
  );
});
