import type { Logger } from "pino";
import type { MultiHttpProvider } from "../acquisition/coordinator.js";
import type { BackendConfig } from "../config/schema.js";
import { loadSecret, SecretError } from "../config/secrets.js";
import { serviceAccount } from "./google-auth.js";
import { createScheduleProvider } from "./provider.js";

export type ScheduleDisabledReason =
  "calendar_id_unset" | SecretError["reason"] | "invalid_credentials";

/** Startup-only wiring (technology-stack 18.7). Returns null when the Schedule
 * Provider is not registered; the Backend and other States continue. Logs a
 * fixed Event and classification only, never the ID, path or Secret.
 */
export async function scheduleProvider(
  config: BackendConfig,
  logger: Pick<Logger, "debug" | "info" | "warn">,
  load: typeof loadSecret = loadSecret,
): Promise<MultiHttpProvider | null> {
  const disabled = (reason: ScheduleDisabledReason) => {
    logger[reason === "calendar_id_unset" ? "info" : "warn"](
      { event: "schedule_provider_disabled", reason },
      "Schedule Provider disabled",
    );
    return null;
  };
  const calendarId = config.scheduleCalendarId;
  if (calendarId === undefined) return disabled("calendar_id_unset");
  let secret: Record<string, unknown>;
  try {
    secret = await load("schedule");
  } catch (error) {
    return disabled(
      error instanceof SecretError ? error.reason : "read_failed",
    );
  }
  const account = serviceAccount(secret);
  if (!account) return disabled("invalid_credentials");
  logger.info(
    { event: "schedule_provider_enabled" },
    "Schedule Provider enabled",
  );
  return createScheduleProvider({ calendarId, account, logger });
}
