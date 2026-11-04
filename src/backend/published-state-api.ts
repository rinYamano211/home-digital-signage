import {
  STATE_KEYS,
  type StateKey,
} from "./storage/published-state-repository.js";
import type {
  SnapshotValidator,
  ValidationResult,
} from "./storage/published-state-read.js";
import type { RuntimeStoreAccess } from "./storage/store.js";
import { utcInstant } from "./time/utc-instant.js";

export interface PublishedStateMetadata {
  dataUpdatedAt: string | null;
  expiresAt: string | null;
  lastAttemptAt: string | null;
  lastAttemptResult: "success" | "failure" | null;
  publishedAt: string;
  dataSource: "externalApi" | "cache" | null;
}
export interface PublishedState {
  data: Record<string, unknown> | null;
  meta: PublishedStateMetadata;
}
export type PublishedStatesResponse =
  | {
      status: 200;
      body: {
        schemaVersion: 1;
        states: Partial<Record<StateKey, PublishedState>>;
      };
    }
  | { status: 503; body: { error: "database_unavailable" } };
export const DATABASE_UNAVAILABLE: PublishedStatesResponse = Object.freeze({
  status: 503,
  body: Object.freeze({ error: "database_unavailable" as const }),
});

const metaKeys = [
  "dataUpdatedAt",
  "expiresAt",
  "lastAttemptAt",
  "lastAttemptResult",
  "publishedAt",
  "dataSource",
];
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => k in v);
const instantOrNull = (v: unknown) => v === null || utcInstant(v) !== null;
const invalid = (reason: string): ValidationResult<PublishedState> => ({
  valid: false,
  reason,
});

/** Common envelope only (technology-stack 10.2 / 10.4 / 10.6). Domain Schema
 * validation of `data` belongs to the Weather / Schedule Services.
 */
export const publishedStateValidator: SnapshotValidator<PublishedState> =
  Object.freeze({
    schema(value: unknown): ValidationResult<PublishedState> {
      if (!object(value) || !exactKeys(value, ["data", "meta"]))
        return invalid("invalid_envelope");
      const { data, meta } = value;
      if (data !== null && !object(data)) return invalid("invalid_data");
      if (!object(meta) || !exactKeys(meta, metaKeys))
        return invalid("invalid_meta");
      if (
        !instantOrNull(meta.dataUpdatedAt) ||
        !instantOrNull(meta.expiresAt) ||
        !instantOrNull(meta.lastAttemptAt) ||
        utcInstant(meta.publishedAt) === null ||
        ![null, "success", "failure"].includes(
          meta.lastAttemptResult as string | null,
        ) ||
        ![null, "externalApi", "cache"].includes(
          meta.dataSource as string | null,
        )
      )
        return invalid("invalid_meta");
      return { valid: true, value: value as unknown as PublishedState };
    },
    semantic(value: PublishedState): ValidationResult<PublishedState> {
      const m = value.meta;
      if ((m.dataUpdatedAt === null) !== (m.expiresAt === null))
        return invalid("inconsistent_success_history");
      if ((m.lastAttemptAt === null) !== (m.lastAttemptResult === null))
        return invalid("inconsistent_attempt");
      if (
        value.data === null
          ? m.dataSource !== null
          : m.dataSource === null || m.expiresAt === null
      )
        return invalid("inconsistent_data_source");
      return { valid: true, value };
    },
  });

// Asia/Tokyo has no daylight saving time: the local date is UTC+9.
const tokyoDate = (now: number) =>
  new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);

/** Response-time masking (10.8). This creates no new Snapshot. */
function present(
  key: StateKey,
  state: PublishedState,
  now: number,
): PublishedState {
  const expired =
    state.data !== null &&
    (state.meta.expiresAt === null || now >= utcInstant(state.meta.expiresAt)!);
  const staleSchedule =
    key === "schedule" &&
    state.data !== null &&
    state.data.date !== tokyoDate(now);
  if (!expired && !staleSchedule) return state;
  return { data: null, meta: { ...state.meta, dataSource: null } };
}

/** One bulk read. A DB-wide failure is 503; a State that is unpublished,
 * isolated or invalid is omitted without hiding the other States.
 */
export function readPublishedStates(
  runtime: RuntimeStoreAccess | null,
  now = Date.now(),
): PublishedStatesResponse {
  if (!runtime) return DATABASE_UNAVAILABLE;
  try {
    const states: Partial<Record<StateKey, PublishedState>> = {};
    for (const key of STATE_KEYS) {
      const read = runtime.publishedStates.read(key, publishedStateValidator);
      if (read.outcome === "database_error") return DATABASE_UNAVAILABLE;
      if (read.outcome === "latest" || read.outcome === "previous")
        states[key] = present(key, read.snapshot, now);
    }
    return { status: 200, body: { schemaVersion: 1, states } };
  } catch {
    return DATABASE_UNAVAILABLE;
  }
}
