import { describe, expect, test } from "vitest";
import { loadConfig } from "../../src/backend/config/loader.js";

describe("backend config", () => {
  test("defaults and unrelated OS environment", () => {
    expect(loadConfig({ PATH: "anything", HOME: "/tmp" })).toEqual({
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      shutdownTimeoutMs: 10000,
    });
    expect(Object.isFrozen(loadConfig({}))).toBe(true);
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
  ])("rejects invalid config without exposing input: %j", (env) => {
    expect(() => loadConfig(env)).toThrow("Invalid backend configuration");
    try {
      loadConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain("marker");
    }
  });
});
