import type { Logger } from "pino";
import type { MultiHttpProvider } from "../acquisition/coordinator.js";
import type { BackendConfig } from "../config/schema.js";
import { createWeatherProviders } from "./provider.js";

/** Startup-only wiring (technology-stack 16.6). No location: no Weather
 * Provider, and the Backend and other States continue. Logs a fixed Event
 * only, never the location.
 */
export function weatherProviders(
  config: BackendConfig,
  logger: Pick<Logger, "debug" | "info" | "warn">,
): MultiHttpProvider[] {
  const location = config.weatherLocation;
  if (location === undefined) {
    logger.info(
      { event: "weather_provider_disabled", reason: "location_unset" },
      "Weather Provider disabled",
    );
    return [];
  }
  logger.info(
    { event: "weather_provider_enabled" },
    "Weather Provider enabled",
  );
  return createWeatherProviders(location, logger);
}
