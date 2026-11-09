import type { Logger } from "pino";
import type { StateProvider } from "../acquisition/coordinator.js";
import type { BackendConfig } from "../config/schema.js";
import { loadSecret, SecretError } from "../config/secrets.js";
import { API_KEY_PATTERN, createRainForecastProvider } from "./tomorrow-io.js";

export type RainForecastDisabledReason =
  "location_unset" | SecretError["reason"] | "invalid_credentials";

/** Startup-only wiring (technology-stack 21.9). Returns null when the
 * RainForecast Provider is not registered; the Backend and other States
 * continue (the Send Gate then has no HTTP Adapter and never sends). Logs a
 * fixed Event and classification only, never the location, path or Secret.
 * `weather.json`: `{"tomorrowIoApiKey": "<key>"}`.
 */
export async function rainForecastProvider(
  config: BackendConfig,
  logger: Pick<Logger, "debug" | "info" | "warn">,
  load: typeof loadSecret = loadSecret,
): Promise<StateProvider | null> {
  const disabled = (reason: RainForecastDisabledReason) => {
    logger[reason === "location_unset" ? "info" : "warn"](
      { event: "rain_forecast_provider_disabled", reason },
      "RainForecast Provider disabled",
    );
    return null;
  };
  const location = config.weatherLocation;
  if (location === undefined) return disabled("location_unset");
  let secret: Record<string, unknown>;
  try {
    secret = await load("weather");
  } catch (error) {
    return disabled(
      error instanceof SecretError ? error.reason : "read_failed",
    );
  }
  const apiKey = secret.tomorrowIoApiKey;
  if (typeof apiKey !== "string" || !API_KEY_PATTERN.test(apiKey))
    return disabled("invalid_credentials");
  logger.info(
    { event: "rain_forecast_provider_enabled" },
    "RainForecast Provider enabled",
  );
  return createRainForecastProvider({ location, apiKey, logger });
}
