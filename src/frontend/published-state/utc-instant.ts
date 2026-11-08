// 表示用APIの日時（UTC RFC 3339）の検証。BackendのPublished State APIと同じ規則
// （src/backend/time/utc-instant.ts）を、Frontendで独立に持つ（Backendのコードはimportしない）。
// Date.parseだけでは、存在しない日付（2026-02-30）や24:00を翌日に繰り越して受け入れるため、
// 各項目の範囲を先に確かめる。

const UTC =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|\+00:00)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

/** UTC RFC 3339の日時ならepoch ms、そうでなければnull。 */
export function utcInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = UTC.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (
    !validDate(year!, month!, day!) ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 実在する`YYYY-MM-DD`か。 */
export function validDateString(value: string): boolean {
  const m = DATE.exec(value);
  return m !== null && validDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * 予定の`startAt`・`endAt`の検証。BackendのSchedule Domain（technology-stack 18.1）は
 * `Date#toISOString()`の形（例：`2026-11-08T00:00:00.000Z`）で出力し、その形だけを有効とする。
 */
export function scheduleInstant(value: string): number | null {
  const ms = utcInstant(value);
  return ms !== null && new Date(ms).toISOString() === value ? ms : null;
}
