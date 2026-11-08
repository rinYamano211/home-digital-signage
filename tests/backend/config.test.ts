import { describe, expect, test } from "vitest";
import { loadConfig } from "../../src/backend/config/loader.js";

describe("backend config", () => {
  test("defaults and unrelated OS environment", () => {
    expect(loadConfig({ PATH: "anything", HOME: "/tmp" })).toEqual({
      dataDirectory: "/var/lib/home-digital-signage",
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      shutdownTimeoutMs: 10000,
    });
    expect(Object.isFrozen(loadConfig({}))).toBe(true);
  });
  test("Schedule Calendar ID is optional and kept as given (Issue #10)", () => {
    expect(loadConfig({})).not.toHaveProperty("scheduleCalendarId");
    expect(
      loadConfig({ SIGNAGE_SCHEDULE_CALENDAR_ID: "abc123@group.example.test" })
        .scheduleCalendarId,
    ).toBe("abc123@group.example.test");
  });
  test.each(["1", "65535", "4321"])("accepts port %s", (port) =>
    expect(loadConfig({ SIGNAGE_BACKEND_PORT: port }).port).toBe(Number(port)),
  );
  test.each([
    "abc",
    "1.5",
    "0",
    "65536",
    "-1",
    "",
    " ",
    "1e3",
    "0x10",
    "NaN",
    "Infinity",
  ])("rejects port %s", (port) =>
    expect(() => loadConfig({ SIGNAGE_BACKEND_PORT: port })).toThrow(
      "Invalid backend configuration",
    ),
  );
  test.each(["fatal", "error", "warn", "info", "debug", "trace", "silent"])(
    "accepts level %s",
    (logLevel) =>
      expect(loadConfig({ SIGNAGE_LOG_LEVEL: logLevel }).logLevel).toBe(
        logLevel,
      ),
  );
  test.each([
    { SIGNAGE_BACKEND_HOST: "0.0.0.0" },
    { SIGNAGE_BACKEND_HOST: "localhost" },
    { SIGNAGE_LOG_LEVEL: "invalid-credential-marker" },
    { SIGNAGE_SHUTDOWN_TIMEOUT_MS: "9999" },
    { SIGNAGE_SHUTDOWN_TIMEOUT_MS: "10.5" },
    { SIGNAGE_UNKNOWN: "credential-marker" },
    { SIGNAGE_SCHEDULE_CALENDAR_ID: "" },
    { SIGNAGE_SCHEDULE_CALENDAR_ID: "has space-marker" },
    { SIGNAGE_SCHEDULE_CALENDAR_ID: "x".repeat(1025) + "marker" },
  ])("rejects invalid config without exposing input: %j", (env) => {
    expect(() => loadConfig(env)).toThrow("Invalid backend configuration");
    try {
      loadConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain("marker");
    }
  });
});

describe("weather location (Issue #9, technology-stack 16.6)", () => {
  const env = (latitude?: string, longitude?: string) => ({
    ...(latitude === undefined ? {} : { SIGNAGE_WEATHER_LATITUDE: latitude }),
    ...(longitude === undefined
      ? {}
      : { SIGNAGE_WEATHER_LONGITUDE: longitude }),
  });
  test("both unset: no location", () =>
    expect(loadConfig({})).not.toHaveProperty("weatherLocation"));
  test("both set: numbers, frozen, not rounded", () => {
    const config = loadConfig(env("12.345678", "-123.456789"));
    expect(config.weatherLocation).toEqual({
      latitude: 12.345678,
      longitude: -123.456789,
    });
    expect(Object.isFrozen(config.weatherLocation)).toBe(true);
  });
  test.each([
    ["90", "180"],
    ["-90", "-180"],
    ["0", "0"],
    ["-0.5", "1.25"],
    ["012.34", "001.5"],
    ["35.1", "139.123456"],
  ])("accepts %s / %s", (latitude, longitude) =>
    expect(loadConfig(env(latitude, longitude)).weatherLocation).toEqual({
      latitude: Number(latitude),
      longitude: Number(longitude),
    }),
  );
  test.each([
    ["only the latitude", env("35.1")],
    ["only the longitude", env(undefined, "139.1")],
    ["empty latitude", env("", "139.1")],
    ["empty longitude", env("35.1", "")],
    ["latitude 90.000001", env("90.000001", "0")],
    ["latitude -90.5", env("-90.5", "0")],
    ["longitude 180.1", env("0", "180.1")],
    ["longitude -181", env("0", "-181")],
    ["leading space", env(" 35.1", "139.1")],
    ["trailing space", env("35.1", "139.1 ")],
    ["a plus sign", env("+35.1", "139.1")],
    ["an exponent", env("3.51e1", "139.1")],
    ["Infinity", env("Infinity", "139.1")],
    ["NaN", env("35.1", "NaN")],
    ["7 fraction digits", env("35.1234567", "139.1")],
    ["4 integer digits", env("0035.1", "139.1")],
    ["a trailing dot", env("35.", "139.1")],
    ["a leading dot", env(".5", "139.1")],
    ["a comma", env("35,1", "139.1")],
    ["hex", env("0x10", "139.1")],
    ["a double minus", env("--35.1", "139.1")],
  ])("rejects %s as an invalid Config", (_label, value) =>
    expect(() => loadConfig(value)).toThrow("Invalid backend configuration"),
  );
});
