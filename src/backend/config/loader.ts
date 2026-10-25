import { Value } from "@sinclair/typebox/value";
import { BackendConfigSchema, type BackendConfig } from "./schema.js";

const names = new Set([
  "SIGNAGE_BACKEND_HOST",
  "SIGNAGE_BACKEND_PORT",
  "SIGNAGE_LOG_LEVEL",
  "SIGNAGE_SHUTDOWN_TIMEOUT_MS",
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
    host: env.SIGNAGE_BACKEND_HOST ?? "127.0.0.1",
    port: integer(env.SIGNAGE_BACKEND_PORT ?? "3000"),
    logLevel: env.SIGNAGE_LOG_LEVEL ?? "info",
    shutdownTimeoutMs: integer(env.SIGNAGE_SHUTDOWN_TIMEOUT_MS ?? "10000"),
  };
  if (!Value.Check(BackendConfigSchema, candidate)) throw new ConfigError();
  return Object.freeze(candidate);
}
