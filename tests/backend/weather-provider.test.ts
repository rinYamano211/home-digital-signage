// Issue #9 Open-Meteo Providers with a fake ctx.http (technology-stack 16.6).
// Synthetic responses and a synthetic location only; no network.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  AcquireContext,
  AcquireResult,
  MultiHttpProvider,
} from "../../src/backend/acquisition/coordinator.js";
import {
  ABSOLUTE_MAX_BODY_BYTES,
  type HttpAdapterConfig,
  type HttpOutcome,
} from "../../src/backend/http/outcome.js";
import { createWeatherProviders } from "../../src/backend/weather/provider.js";
import { weatherProviders } from "../../src/backend/weather/setup.js";
import type { BackendConfig } from "../../src/backend/config/schema.js";

const LOCATION = { latitude: 12.345678, longitude: -123.456789 };
const H = 3_600_000;
const D = 24 * H;
const JST = 9 * H;
/** Wall clock in JST, e.g. jst("2026-11-08T10:25:00"). */
const jst = (local: string) => Date.parse(`${local}+09:00`);
/** Open-Meteo local time (no offset) of epoch ms, e.g. 2026-11-08T10:00. */
const local = (ms: number) => new Date(ms + JST).toISOString().slice(0, 16);
const localDate = (ms: number) => new Date(ms + JST).toISOString().slice(0, 10);

let wall = 0;
beforeEach(() => {
  wall = jst("2026-11-08T10:25:00");
  vi.spyOn(Date, "now").mockImplementation(() => wall);
});
afterEach(() => vi.restoreAllMocks());

const json = (v: unknown, status = 200, retryAfter?: string): HttpOutcome => ({
  kind: "response",
  http: { status, ...(retryAfter ? { retryAfter } : {}) },
  body: new TextEncoder().encode(JSON.stringify(v)),
});
const envelope = (block: Record<string, unknown>) => ({
  latitude: 12.375,
  longitude: -123.5,
  utc_offset_seconds: 32400,
  timezone: "Asia/Tokyo",
  ...block,
});
const currentBody = (over: Record<string, unknown> = {}) =>
  envelope({
    current: {
      time: "2026-11-08T10:15",
      interval: 900,
      temperature_2m: 14.2,
      weather_code: 3,
      is_day: 1,
      ...over,
    },
  });
/** 72 hourly entries from JST 00:00 of `day` (forecast_days=3). */
function hourlyColumns(day = "2026-11-08", count = 72) {
  const start = jst(`${day}T00:00:00`);
  const time = Array.from({ length: count }, (_, i) => local(start + i * H));
  return {
    time,
    temperature_2m: time.map((_, i) => 10 + (i % 10) / 10),
    weather_code: time.map(() => 2),
    precipitation_probability: time.map((_, i) => i % 101),
  } as Record<string, unknown[]>;
}
const hourlyBody = (columns = hourlyColumns()) => envelope({ hourly: columns });
/** 9 daily entries from `day` (forecast_days=9). */
function dailyColumns(day = "2026-11-08", count = 9) {
  const start = jst(`${day}T00:00:00`);
  const time = Array.from({ length: count }, (_, i) =>
    localDate(start + i * D),
  );
  return {
    time,
    weather_code: time.map(() => 61),
    temperature_2m_max: time.map((_, i) => 18 + i),
    temperature_2m_min: time.map((_, i) => 8 + i),
    precipitation_probability_max: time.map(() => 40),
  } as Record<string, unknown[]>;
}
const dailyBody = (columns = dailyColumns()) => envelope({ daily: columns });

type Kind = "currentWeather" | "hourlyWeather" | "weeklyWeather";
function fixture(kind: Kind) {
  const logs: [string, Record<string, unknown>][] = [];
  const logger = {
    debug: (o: Record<string, unknown>) => logs.push(["debug", o]),
    warn: (o: Record<string, unknown>) => logs.push(["warn", o]),
  } as unknown as Parameters<typeof createWeatherProviders>[1];
  const provider = createWeatherProviders(LOCATION, logger).find(
    (p) => p.stateKey === kind,
  )!;
  const requests: HttpAdapterConfig[] = [];
  const abort = new AbortController();
  let respond: () => HttpOutcome = () => {
    throw new Error("unexpected request");
  };
  const ctx = (): AcquireContext => ({
    startedAt: new Date(wall).toISOString(),
    signal: abort.signal,
    http: async (config) => {
      requests.push(config);
      return respond();
    },
  });
  const run = (outcome: HttpOutcome | (() => HttpOutcome)) => {
    respond = typeof outcome === "function" ? outcome : () => outcome;
    return provider.acquire(ctx());
  };
  return { provider, logs, requests, abort, run };
}
/** Location never appears in logs, data or results (16.6). */
const noLocation = (...values: unknown[]) => {
  const text = JSON.stringify(values);
  for (const s of ["12.345678", "123.456789", "12.375", "123.5"])
    expect(text).not.toContain(s);
};
const failed = (logs: [string, Record<string, unknown>][]) =>
  logs.filter(([, o]) => o.event === "weather_acquisition_failed");
const success = (result: AcquireResult) => {
  expect(result.kind).toBe("success");
  return result as Extract<AcquireResult, { kind: "success" }>;
};

test("three independent Providers: no Quota, no nextPeriodMs, 15 min / 30 min / 6 h", () => {
  const providers = createWeatherProviders(LOCATION, {
    debug: vi.fn(),
    warn: vi.fn(),
  } as never);
  expect(providers.map((p) => [p.stateKey, p.periodMs, p.quota])).toEqual([
    ["currentWeather", 15 * 60_000, false],
    ["hourlyWeather", 30 * 60_000, false],
    ["weeklyWeather", 6 * H, false],
  ]);
  for (const p of providers) {
    expect(p.nextPeriodMs).toBeUndefined();
    expect(Object.isFrozen(p)).toBe(true);
  }
});

test.each([
  ["currentWeather", { current: "temperature_2m,weather_code,is_day" }],
  [
    "hourlyWeather",
    {
      hourly: "temperature_2m,weather_code,precipitation_probability",
      forecast_days: "3",
    },
  ],
  [
    "weeklyWeather",
    {
      daily:
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      forecast_days: "9",
    },
  ],
] as const)("%s: one GET with its own parameters", async (kind, own) => {
  const f = fixture(kind);
  await f.run(json({}, 503));
  expect(f.requests).toHaveLength(1);
  const [request] = f.requests;
  expect(request!.method).toBeUndefined();
  expect(request!.maxBodyBytes).toBe(ABSOLUTE_MAX_BODY_BYTES);
  const url = new URL(request!.url);
  expect(url.origin + url.pathname).toBe(
    "https://api.open-meteo.com/v1/forecast",
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    latitude: "12.345678",
    longitude: "-123.456789",
    timezone: "Asia/Tokyo",
    ...own,
  });
});

// ---- CurrentWeather (19.2 / 19.3) ----
test("current: JST local time to UTC, 2 h TTL from completion, debug log only", async () => {
  const f = fixture("currentWeather");
  const result = success(
    await f.run(() => {
      wall += 1_500; // completion after the response
      return json(currentBody());
    }),
  );
  expect(result.data).toEqual({
    temperatureC: 14.2,
    weatherCode: 3,
    isDay: true,
    validAt: "2026-11-08T01:15:00.000Z",
  });
  expect(result.expiresAt).toBe(new Date(wall + 2 * H).toISOString());
  expect(f.logs).toEqual([
    [
      "debug",
      { event: "weather_acquired", stateKey: "currentWeather", count: 1 },
    ],
  ]);
  noLocation(f.logs, result);
});

test("current: is_day 0 and an unknown integer weather code are kept", async () => {
  const f = fixture("currentWeather");
  const result = success(
    await f.run(json(currentBody({ is_day: 0, weather_code: 12345 }))),
  );
  expect(result.data).toMatchObject({ isDay: false, weatherCode: 12345 });
});

test.each([
  ["30 min in the past", "2026-11-08T10:30:00.000", true],
  ["past tolerance + 1 ms", "2026-11-08T10:30:00.001", false],
  ["5 min in the future", "2026-11-08T09:55:00.000", true],
  ["future tolerance + 1 ms", "2026-11-08T09:54:59.999", false],
])("current freshness at adoption: %s", async (_label, adoption, adopted) => {
  const f = fixture("currentWeather");
  wall = jst("2026-11-08T09:50:00"); // start; freshness uses adoption
  const result = await f.run(() => {
    wall = jst(adoption);
    return json(currentBody({ time: "2026-11-08T10:00" }));
  });
  expect(result.kind).toBe(adopted ? "success" : "failure");
  if (!adopted)
    expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "stale_data" });
});

test.each([
  ["interval 0", { interval: 0 }],
  ["interval 1.5", { interval: 1.5 }],
  ["interval missing", { interval: undefined }],
  ["is_day 2", { is_day: 2 }],
  ["is_day true", { is_day: true }],
  ["weather_code 1.5", { weather_code: 1.5 }],
  ["weather_code string", { weather_code: "3" }],
  ["temperature null", { temperature_2m: null }],
  ["temperature string", { temperature_2m: "14" }],
  ["time with offset", { time: "2026-11-08T10:15+09:00" }],
  ["time with seconds", { time: "2026-11-08T10:15:00" }],
  ["non-existent time", { time: "2026-11-31T10:15" }],
  ["time 24:00", { time: "2026-11-08T24:00" }],
])("current: %s is invalid_response", async (_label, over) => {
  const f = fixture("currentWeather");
  expect(await f.run(json(currentBody(over)))).toEqual({ kind: "failure" });
  expect(failed(f.logs)).toEqual([
    [
      "warn",
      {
        event: "weather_acquisition_failed",
        stateKey: "currentWeather",
        reason: "invalid_response",
      },
    ],
  ]);
});

test("current: a missing current block is invalid_response", async () => {
  const f = fixture("currentWeather");
  await f.run(json(envelope({})));
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "invalid_response" });
});

// ---- Response envelope and HTTP classification (16.6) ----
test.each([
  ["utc_offset_seconds 0", { ...currentBody(), utc_offset_seconds: 0 }],
  [
    "utc_offset_seconds missing",
    { ...currentBody(), utc_offset_seconds: undefined },
  ],
  [
    "utc_offset_seconds string",
    { ...currentBody(), utc_offset_seconds: "32400" },
  ],
  ["an array Body", [currentBody()]],
])("%s is invalid_response", async (_label, body) => {
  const f = fixture("currentWeather");
  await f.run(json(body));
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "invalid_response" });
});

test.each([
  ["not JSON", new TextEncoder().encode("<html>")],
  ["invalid UTF-8", new Uint8Array([0xff, 0xfe, 0x7b, 0x7d])],
])("a Body that is %s is invalid_response", async (_label, body) => {
  const f = fixture("currentWeather");
  await f.run({ kind: "response", http: { status: 200 }, body });
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "invalid_response" });
});

const failures: [string, HttpOutcome, string, AcquireResult][] = [
  [
    "429 with Retry-After",
    json({}, 429, "120"),
    "rate_limited",
    { kind: "failure", httpStatus: 429, retryAfter: "120" },
  ],
  [
    "429 without Retry-After",
    json({}, 429),
    "rate_limited",
    { kind: "failure", httpStatus: 429 },
  ],
  ["500", json({}, 500), "server_error", { kind: "failure", httpStatus: 500 }],
  ["503", json({}, 503), "server_error", { kind: "failure", httpStatus: 503 }],
  [
    "400 invalid parameters",
    json({ error: true, reason: "secret-reason-marker" }, 400),
    "http_error",
    { kind: "failure", httpStatus: 400 },
  ],
  ["404", json({}, 404), "http_error", { kind: "failure", httpStatus: 404 }],
  ["204", json({}, 204), "http_error", { kind: "failure", httpStatus: 204 }],
  ["timeout", { kind: "timeout" }, "timeout", { kind: "failure" }],
  [
    "network error",
    { kind: "network_error" },
    "network_error",
    { kind: "failure" },
  ],
  [
    "Body read error",
    { kind: "body_error", http: { status: 200 } },
    "network_error",
    { kind: "failure", httpStatus: 200 },
  ],
  [
    "Body over the limit",
    { kind: "body_too_large", http: { status: 200 } },
    "invalid_response",
    { kind: "failure", httpStatus: 200 },
  ],
];
test.each(failures)(
  "%s: fixed classification, status and Retry-After for the Backoff",
  async (_label, outcome, reason, expected) => {
    for (const kind of [
      "currentWeather",
      "hourlyWeather",
      "weeklyWeather",
    ] as const) {
      const f = fixture(kind);
      expect(await f.run(outcome)).toEqual(expected);
      expect(f.logs).toEqual([
        [
          "warn",
          {
            event: "weather_acquisition_failed",
            stateKey: kind,
            reason,
            ...(expected.kind === "failure" && expected.httpStatus
              ? { httpStatus: expected.httpStatus }
              : {}),
          },
        ],
      ]);
      expect(JSON.stringify(f.logs)).not.toContain("marker");
      expect(JSON.stringify(f.logs)).not.toContain("open-meteo");
      noLocation(f.logs);
    }
  },
);

test("Shutdown during the HTTP: failure without a log or data", async () => {
  for (const kind of [
    "currentWeather",
    "hourlyWeather",
    "weeklyWeather",
  ] as const) {
    const f = fixture(kind);
    const body =
      kind === "currentWeather"
        ? currentBody()
        : kind === "hourlyWeather"
          ? hourlyBody()
          : dailyBody();
    expect(
      await f.run(() => {
        f.abort.abort();
        return json(body);
      }),
    ).toEqual({ kind: "failure" });
    expect(f.logs).toEqual([]);
  }
});

test("an aborted transport failure is not logged either", async () => {
  const f = fixture("hourlyWeather");
  await f.run(() => {
    f.abort.abort();
    return { kind: "aborted" };
  });
  expect(f.logs).toEqual([]);
});

// ---- HourlyWeather (20.2 / 20.3) ----
const validAts = (r: AcquireResult) =>
  (success(r).data.hours as { validAt: string }[]).map((h) => h.validAt);

test("hourly: 36 slots from the next hour, kept with the 2 h TTL", async () => {
  const f = fixture("hourlyWeather"); // 10:25 JST
  const result = success(await f.run(json(hourlyBody())));
  const hours = result.data.hours as Record<string, unknown>[];
  expect(hours).toHaveLength(36);
  expect(hours[0]).toEqual({
    validAt: "2026-11-08T02:00:00.000Z", // 11:00 JST
    temperatureC: 10.1,
    weatherCode: 2,
    precipitationProbability: 11,
  });
  expect(hours.at(-1)!.validAt).toBe("2026-11-09T13:00:00.000Z"); // +1 22:00
  expect(result.expiresAt).toBe(new Date(wall + 2 * H).toISOString());
  expect(f.logs).toEqual([
    [
      "debug",
      { event: "weather_acquired", stateKey: "hourlyWeather", count: 36 },
    ],
  ]);
  noLocation(f.logs, result);
});

test("hourly: an exact hour start includes that hour", async () => {
  const f = fixture("hourlyWeather");
  wall = jst("2026-11-08T11:00:00");
  expect(validAts(await f.run(json(hourlyBody())))[0]).toBe(
    "2026-11-08T02:00:00.000Z",
  );
});

test("hourly: a 23:30 start takes 36 slots from 00:00 of the next day", async () => {
  const f = fixture("hourlyWeather");
  wall = jst("2026-11-08T23:30:00");
  const at = validAts(await f.run(json(hourlyBody())));
  expect(at).toHaveLength(36);
  expect(at[0]).toBe("2026-11-08T15:00:00.000Z"); // 11/09 00:00 JST
});

test("hourly: crossing the hour during the attempt keeps the start's slots", async () => {
  const f = fixture("hourlyWeather");
  wall = jst("2026-11-08T10:59:58");
  const at = validAts(
    await f.run(() => {
      wall = jst("2026-11-08T11:00:03");
      return json(hourlyBody());
    }),
  );
  // Not trimmed at adoption: 11:00 stays; the Frontend selects 12 slots.
  expect(at[0]).toBe("2026-11-08T02:00:00.000Z");
  expect(at).toHaveLength(36);
});

test("hourly: the re-check from the adoption hour needs 24 slots", async () => {
  // Only 24 slots exist from 11:00 (11:00 to the next day 10:00).
  const columns = hourlyColumns();
  for (const name of Object.keys(columns))
    columns[name] = columns[name]!.slice(0, 35);
  let f = fixture("hourlyWeather");
  wall = jst("2026-11-08T10:59:58");
  expect(validAts(await f.run(json(hourlyBody(columns))))).toHaveLength(24);
  f = fixture("hourlyWeather");
  wall = jst("2026-11-08T10:59:58");
  const result = await f.run(() => {
    wall = jst("2026-11-08T11:00:03"); // needs 12:00 + 24 = up to 11:00 +1
    return json(hourlyBody(columns));
  });
  expect(result).toEqual({ kind: "failure" });
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "stale_data" });
});

test("hourly: the clock moving back before the start hour fails the re-check", async () => {
  const f = fixture("hourlyWeather");
  wall = jst("2026-11-08T11:00:00");
  await f.run(() => {
    wall = jst("2026-11-08T09:30:00");
    return json(hourlyBody());
  });
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "stale_data" });
});

test.each([
  [25, 25],
  [30, 30],
  [36, 36],
  [40, 36],
])(
  "hourly: %i available slots adopt %i (spare range 25-36)",
  async (available, adopted) => {
    const columns = hourlyColumns();
    for (const name of Object.keys(columns))
      columns[name] = columns[name]!.slice(0, 11 + available);
    const f = fixture("hourlyWeather");
    expect(validAts(await f.run(json(hourlyBody(columns))))).toHaveLength(
      adopted,
    );
  },
);

test("hourly: fewer than 24 slots from the start hour is stale_data", async () => {
  const columns = hourlyColumns();
  for (const name of Object.keys(columns))
    columns[name] = columns[name]!.slice(0, 11 + 23);
  const f = fixture("hourlyWeather");
  expect(await f.run(json(hourlyBody(columns)))).toEqual({ kind: "failure" });
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "stale_data" });
});

test("hourly: no slot at the start hour is stale_data", async () => {
  const f = fixture("hourlyWeather");
  wall = jst("2026-11-11T10:25:00"); // after the 3 days in the response
  await f.run(json(hourlyBody()));
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "stale_data" });
});

const slot = 11 + 10; // 10th slot from 11:00 JST, inside the required range
test.each([
  ["temperature null", "temperature_2m", null],
  ["temperature string", "temperature_2m", "10"],
  ["weather code 2.5", "weather_code", 2.5],
  ["precipitation 101", "precipitation_probability", 101],
  ["precipitation -1", "precipitation_probability", -1],
  ["precipitation null", "precipitation_probability", null],
  ["time with offset", "time", "2026-11-08T21:00+09:00"],
  ["time gap", "time", "2026-11-08T22:00"],
  ["duplicate time", "time", "2026-11-08T20:00"],
])(
  "hourly: %s inside the required 24 is invalid_response",
  async (_label, name, value) => {
    const columns = hourlyColumns();
    columns[name]![slot] = value;
    const f = fixture("hourlyWeather");
    expect(await f.run(json(hourlyBody(columns)))).toEqual({
      kind: "failure",
    });
    expect(failed(f.logs)[0]![1]).toMatchObject({
      stateKey: "hourlyWeather",
      reason: "invalid_response",
    });
  },
);

test("hourly: the first anomaly in the spare range truncates there", async () => {
  const columns = hourlyColumns();
  columns.precipitation_probability![11 + 30] = null; // 31st slot
  columns.precipitation_probability![11 + 33] = 999; // later ones are not used
  const f = fixture("hourlyWeather");
  expect(validAts(await f.run(json(hourlyBody(columns))))).toHaveLength(30);
});

test("hourly: slots before the start hour are not used or checked", async () => {
  const columns = hourlyColumns();
  columns.temperature_2m![3] = null;
  const f = fixture("hourlyWeather");
  expect(validAts(await f.run(json(hourlyBody(columns))))).toHaveLength(36);
});

test("hourly: a start hidden behind malformed times is invalid_response", async () => {
  const columns = hourlyColumns();
  columns.time![11] = "2026-11-08 11:00";
  const f = fixture("hourlyWeather");
  await f.run(json(hourlyBody(columns)));
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "invalid_response" });
});

test.each([
  ["a missing array", (c: Record<string, unknown>) => delete c.weather_code],
  [
    "a length mismatch",
    (c: Record<string, unknown[]>) => c.temperature_2m!.pop(),
  ],
  [
    "a non-array",
    (c: Record<string, unknown>) => (c.time = "2026-11-08T00:00"),
  ],
])("hourly: %s is a structural invalid_response", async (_label, broke) => {
  const columns = hourlyColumns();
  broke(columns as never);
  const f = fixture("hourlyWeather");
  await f.run(json(hourlyBody(columns)));
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "invalid_response" });
});

test("hourly: a missing hourly block is invalid_response", async () => {
  const f = fixture("hourlyWeather");
  await f.run(json(envelope({})));
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "invalid_response" });
});

// ---- WeeklyWeather (22.3 / 22.4) ----
const dates = (r: AcquireResult) =>
  (success(r).data.days as { date: string }[]).map((d) => d.date);

test("weekly: 9 days from the start's JST date, kept with the 12 h TTL", async () => {
  const f = fixture("weeklyWeather");
  const result = success(await f.run(json(dailyBody())));
  const days = result.data.days as Record<string, unknown>[];
  expect(days).toHaveLength(9);
  expect(days[0]).toEqual({
    date: "2026-11-08",
    weatherCode: 61,
    temperatureMaxC: 18,
    temperatureMinC: 8,
    precipitationProbability: 40,
  });
  expect(days.at(-1)!.date).toBe("2026-11-16");
  expect(result.expiresAt).toBe(new Date(wall + 12 * H).toISOString());
  expect(f.logs).toEqual([
    [
      "debug",
      { event: "weather_acquired", stateKey: "weeklyWeather", count: 9 },
    ],
  ]);
  noLocation(f.logs, result);
});

test("weekly: the start is the JST date, not the UTC date", async () => {
  const f = fixture("weeklyWeather");
  wall = jst("2026-11-08T00:30:00"); // 11/07 15:30 UTC
  expect(dates(await f.run(json(dailyBody())))[0]).toBe("2026-11-08");
});

test("weekly: crossing midnight keeps the start's days when day 8 is valid", async () => {
  const f = fixture("weeklyWeather");
  wall = jst("2026-11-08T23:59:58");
  const result = await f.run(() => {
    wall = jst("2026-11-09T00:00:03");
    return json(dailyBody());
  });
  expect(dates(result)[0]).toBe("2026-11-08"); // not trimmed at adoption
});

test("weekly: crossing midnight with an invalid day 8 fails the re-check", async () => {
  const columns = dailyColumns();
  columns.temperature_2m_min![7] = 99; // min > max on day 8
  const f = fixture("weeklyWeather");
  wall = jst("2026-11-08T23:59:58");
  const result = await f.run(() => {
    wall = jst("2026-11-09T00:00:03");
    return json(dailyBody(columns));
  });
  expect(result).toEqual({ kind: "failure" });
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "stale_data" });
});

test.each([
  ["day 9 invalid", 8, 8],
  ["day 8 invalid, day 9 valid", 7, 7],
])("weekly: %s adopts %i days", async (_label, index, adopted) => {
  const columns = dailyColumns();
  columns.precipitation_probability_max![index] = null;
  const f = fixture("weeklyWeather");
  expect(dates(await f.run(json(dailyBody(columns))))).toHaveLength(adopted);
});

test.each([
  ["min > max", "temperature_2m_min", 30],
  ["max null", "temperature_2m_max", null],
  ["code 61.5", "weather_code", 61.5],
  ["precipitation 100.5", "precipitation_probability_max", 100.5],
  ["non-existent date", "time", "2026-11-31"],
  ["a gap", "time", "2026-11-12"],
  ["a duplicate", "time", "2026-11-10"],
])(
  "weekly: %s inside the required 7 days is invalid_response",
  async (_label, name, value) => {
    const columns = dailyColumns();
    columns[name]![3] = value;
    const f = fixture("weeklyWeather");
    expect(await f.run(json(dailyBody(columns)))).toEqual({
      kind: "failure",
    });
    expect(failed(f.logs)[0]![1]).toMatchObject({
      stateKey: "weeklyWeather",
      reason: "invalid_response",
    });
  },
);

test("weekly: min == max is valid", async () => {
  const columns = dailyColumns();
  columns.temperature_2m_min![2] = columns.temperature_2m_max![2];
  const f = fixture("weeklyWeather");
  expect(dates(await f.run(json(dailyBody(columns))))).toHaveLength(9);
});

test.each([
  ["starts tomorrow", dailyColumns("2026-11-09")],
  ["only 6 days", dailyColumns("2026-11-08", 6)],
])("weekly: a response that %s is stale_data", async (_label, columns) => {
  const f = fixture("weeklyWeather");
  await f.run(json(dailyBody(columns)));
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "stale_data" });
});

test("weekly: a length mismatch is a structural invalid_response", async () => {
  const columns = dailyColumns();
  columns.weather_code!.push(1);
  const f = fixture("weeklyWeather");
  await f.run(json(dailyBody(columns)));
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "invalid_response" });
});

// ---- Startup wiring (16.6) ----
const config = (over: Partial<BackendConfig> = {}): BackendConfig => ({
  dataDirectory: "/synthetic",
  host: "127.0.0.1",
  port: 3000,
  logLevel: "info",
  shutdownTimeoutMs: 10000,
  ...over,
});
const setupLogger = () => {
  const logs: unknown[] = [];
  return {
    logs,
    logger: {
      debug: (o: unknown) => logs.push(["debug", o]),
      info: (o: unknown) => logs.push(["info", o]),
      warn: (o: unknown) => logs.push(["warn", o]),
    } as never,
  };
};

test("setup: no location registers nothing and logs location_unset", () => {
  const { logs, logger } = setupLogger();
  expect(weatherProviders(config(), logger)).toEqual([]);
  expect(logs).toEqual([
    ["info", { event: "weather_provider_disabled", reason: "location_unset" }],
  ]);
});

test("setup: a location registers the three Providers without logging it", () => {
  const { logs, logger } = setupLogger();
  const providers: MultiHttpProvider[] = weatherProviders(
    config({ weatherLocation: LOCATION }),
    logger,
  );
  expect(providers.map((p) => p.stateKey)).toEqual([
    "currentWeather",
    "hourlyWeather",
    "weeklyWeather",
  ]);
  expect(logs).toEqual([["info", { event: "weather_provider_enabled" }]]);
  noLocation(logs);
});

test("weekly: the clock moving back to the previous date fails the re-check", async () => {
  const f = fixture("weeklyWeather");
  wall = jst("2026-11-08T00:00:01");
  const result = await f.run(() => {
    wall = jst("2026-11-07T23:59:59");
    return json(dailyBody());
  });
  expect(result).toEqual({ kind: "failure" });
  expect(failed(f.logs)[0]![1]).toMatchObject({ reason: "stale_data" });
});
