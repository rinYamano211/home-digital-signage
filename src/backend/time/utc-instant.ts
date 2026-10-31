/** UTC RFC3339, using the millisecond clock representation of JS Date. */
export function utcInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|\+00:00)$/.exec(
      value,
    );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  const fraction = /\.(\d+)/.exec(value)?.[1];
  // Date.parse truncates fractions beyond milliseconds. Preserve the remainder
  // to the precision supported by the epoch-millisecond number representation.
  return instant + (fraction ? (Number("0." + fraction) * 1000) % 1 : 0);
}
