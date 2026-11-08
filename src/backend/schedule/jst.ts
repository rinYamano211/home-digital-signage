/** Asia/Tokyo calendar dates (technology-stack 18.3). Asia/Tokyo has no
 * daylight saving time, so the local date is always UTC+9.
 */
const OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD of the JST day containing `ms`. */
export function tokyoDate(ms: number): string {
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms of JST 00:00 on `date`, or null for a non-existent date. */
export function tokyoDayStart(date: string): number | null {
  const match = DATE.exec(date);
  if (!match) return null;
  const utc = Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!);
  // Rejects 2026-02-30 etc.: the round trip must give the same date.
  if (new Date(utc).toISOString().slice(0, 10) !== date) return null;
  return utc - OFFSET_MS;
}

/** Epoch ms of the next JST 00:00 strictly after `ms`. */
export function nextTokyoMidnight(ms: number): number {
  return tokyoDayStart(tokyoDate(ms))! + DAY_MS;
}

/** RFC 3339 with the +09:00 offset, e.g. 2026-11-08T00:00:00+09:00. */
export function tokyoDayStartRfc3339(date: string): string {
  return `${date}T00:00:00+09:00`;
}

/** `date` plus `days` calendar days (YYYY-MM-DD). */
export function addDays(date: string, days: number): string {
  return tokyoDate(tokyoDayStart(date)! + days * DAY_MS);
}
