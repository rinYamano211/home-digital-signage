import { Value } from "@sinclair/typebox/value";
import { BackendConfigSchema, type BackendConfig } from "./schema.js";

const names = new Set([
  "SIGNAGE_DATA_DIR",
  "SIGNAGE_BACKEND_HOST",
  "SIGNAGE_BACKEND_PORT",
  "SIGNAGE_LOG_LEVEL",
  "SIGNAGE_SHUTDOWN_TIMEOUT_MS",
  "SIGNAGE_SCHEDULE_CALENDAR_ID",
  "SIGNAGE_WEATHER_LATITUDE",
  "SIGNAGE_WEATHER_LONGITUDE",
]);

export class ConfigError extends Error {
  constructor() {
    super("Invalid backend configuration");
    this.name = "ConfigError";
  }
}

function integer(value: string): number {
  if (!/^\d+$/.test(value)) throw new ConfigError();
  return Number(value);
}

/** Plain decimal only (technology-stack 16.6): optional "-", 1-3 integer
 * digits, optional 1-6 fraction digits. No exponent, "+", spaces, Infinity or
 * NaN. Rounding to 2 digits is the user's rule and is not enforced here.
 */
function coordinate(value: string): number {
  if (!/^-?\d{1,3}(\.\d{1,6})?$/.test(value)) throw new ConfigError();
  return Number(value);
}

/** Both unset: no Weather Provider. Only one set is an invalid Config. */
function weatherLocation(env: Readonly<NodeJS.ProcessEnv>) {
  const latitude = env.SIGNAGE_WEATHER_LATITUDE;
  const longitude = env.SIGNAGE_WEATHER_LONGITUDE;
  if (latitude === undefined && longitude === undefined) return {};
  if (latitude === undefined || longitude === undefined)
    throw new ConfigError();
  return {
    weatherLocation: Object.freeze({
      latitude: coordinate(latitude),
      longitude: coordinate(longitude),
    }),
  };
}

export function loadConfig(env: Readonly<NodeJS.ProcessEnv>): BackendConfig {
  // Never include environment names/values or validation input in errors.
  if (
    Object.keys(env).some(
      (key) => key.startsWith("SIGNAGE_") && !names.has(key),
    )
  ) {
    throw new ConfigError();
  }
  const candidate = {
    dataDirectory: env.SIGNAGE_DATA_DIR ?? "/var/lib/home-digital-signage",
    host: env.SIGNAGE_BACKEND_HOST ?? "127.0.0.1",
    port: integer(env.SIGNAGE_BACKEND_PORT ?? "3000"),
    logLevel: env.SIGNAGE_LOG_LEVEL ?? "info",
    shutdownTimeoutMs: integer(env.SIGNAGE_SHUTDOWN_TIMEOUT_MS ?? "10000"),
    ...(env.SIGNAGE_SCHEDULE_CALENDAR_ID === undefined
      ? {}
      : { scheduleCalendarId: env.SIGNAGE_SCHEDULE_CALENDAR_ID }),
    ...weatherLocation(env),
  };
  if (!Value.Check(BackendConfigSchema, candidate)) throw new ConfigError();
  return Object.freeze(candidate);
}
