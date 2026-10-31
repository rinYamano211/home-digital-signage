import { utcInstant } from "../time/utc-instant.js";
import type { StateKey } from "../storage/published-state-repository.js";

export interface AcquisitionControlState {
  consecutiveFailures: number;
  nextAttemptAt: string;
}
export function controlState(value: unknown): AcquisitionControlState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as AcquisitionControlState;
  // Read caller properties once; serialize only the validated plain copy.
  const consecutiveFailures = v.consecutiveFailures;
  const nextAttemptAt = v.nextAttemptAt;
  if (
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "consecutiveFailures") ||
    !Object.hasOwn(value, "nextAttemptAt") ||
    !Number.isSafeInteger(consecutiveFailures) ||
    consecutiveFailures < 0 ||
    utcInstant(nextAttemptAt) === null
  )
    return null;
  return { consecutiveFailures, nextAttemptAt };
}
function instant(value: string): number {
  const n = utcInstant(value);
  if (n === null) throw new TypeError("Invalid UTC instant");
  return n;
}
function timestamp(n: number): string {
  if (!Number.isFinite(n) || !Number.isFinite(new Date(n).getTime()))
    throw new RangeError("Time outside Date range");
  const value = new Date(n).toISOString();
  if (utcInstant(value) === null)
    throw new RangeError("Time outside UTC contract");
  return value;
}
/** Retry-After delta-seconds or HTTP-date, without permissive Date.parse repair. */
export function retryAfterAt(
  value: string | undefined,
  completedAt: string,
): number | null {
  const base = instant(completedAt);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    const at = base + seconds * 1000;
    return Number.isSafeInteger(seconds) &&
      Number.isSafeInteger(at) &&
      Number.isFinite(new Date(at).getTime())
      ? at
      : null;
  }
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // IMF-fixdate and the two obsolete HTTP-date forms accepted by HTTP recipients.
  const imf =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(
      text,
    );
  const old =
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(
      text,
    );
  const asc =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(
      text,
    );
  let day: string, month: string, year: number, time: string, weekday: string;
  if (imf || old) {
    const m = (imf ?? old)!;
    [, weekday, day, month, , time] = m;
    year = Number(m[4]);
    if (old) {
      const current = new Date(base).getUTCFullYear();
      year += Math.floor(current / 100) * 100;
      if (year > current + 50) year -= 100;
    }
  } else if (asc) {
    [, weekday, month, day, time] = asc;
    year = Number(asc[5]);
    day = day.trim().padStart(2, "0");
  } else return null;
  const monthIndex = months.indexOf(month);
  if (monthIndex < 0) return null;
  const at = utcInstant(
    `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${day}T${time}Z`,
  );
  return at !== null && days[new Date(at).getUTCDay()] === weekday.slice(0, 3)
    ? at
    : null;
}
export type AcquisitionOutcome =
  | { kind: "success"; startedAt: string; periodMs: number }
  | {
      kind: "failure";
      completedAt: string;
      httpStatus?: number;
      retryAfter?: string;
    }
  | { kind: "quota_suppressed" };
/** Application calculation only: no HTTP, persistence or automatic retry. */
export function nextControlState(
  previous: AcquisitionControlState,
  outcome: AcquisitionOutcome,
): AcquisitionControlState {
  const valid = controlState(previous);
  if (!valid) throw new TypeError("Invalid Control State");
  if (outcome.kind === "quota_suppressed") return valid;
  if (outcome.kind === "success") {
    if (!Number.isSafeInteger(outcome.periodMs) || outcome.periodMs <= 0)
      throw new TypeError("Invalid acquisition period");
    return {
      consecutiveFailures: 0,
      nextAttemptAt: timestamp(instant(outcome.startedAt) + outcome.periodMs),
    };
  }
  const failures = valid.consecutiveFailures + 1;
  if (!Number.isSafeInteger(failures))
    throw new RangeError("Failure count exhausted");
  const base = instant(outcome.completedAt);
  let at = base + Math.min(30, 2 ** Math.min(5, failures - 1)) * 60000;
  if (outcome.httpStatus === 429)
    at = Math.max(
      at,
      retryAfterAt(outcome.retryAfter, outcome.completedAt) ?? at,
    );
  return { consecutiveFailures: failures, nextAttemptAt: timestamp(at) };
}
/** Process-local monotonic wait only. Ready means re-read, never permission to send. */
export class ConservativeControlWait {
  private readonly starts = new Map<StateKey, number>();
  constructor(private readonly now: () => number = () => performance.now()) {}
  check(
    stateKey: StateKey,
    periodMs: number,
  ): { readyForRecheck: boolean; remainingMs: number } {
    if (!Number.isFinite(periodMs) || periodMs <= 0)
      throw new TypeError("Invalid period");
    const now = this.now();
    if (!Number.isFinite(now)) throw new TypeError("Unknown monotonic time");
    let start = this.starts.get(stateKey);
    if (start === undefined || now < start) {
      start = now;
      this.starts.set(stateKey, start);
    }
    const remainingMs = Math.max(0, Math.min(periodMs, 300000) - (now - start));
    return { readyForRecheck: remainingMs === 0, remainingMs };
  }
  clear(stateKey: StateKey): void {
    this.starts.delete(stateKey);
  }
}
