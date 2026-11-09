import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** RainForecast Domain Data and its derivation from 1-minute slots
 * (technology-stack 21.3 - 21.5, 21.9). Pure functions: no HTTP, no logging.
 */
const UtcInstant = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
});
export const RainForecastDataSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("dry"), Type.Literal("raining")]),
    intensity: Type.Union([
      Type.Literal("light"),
      Type.Literal("moderate"),
      Type.Literal("heavy"),
      Type.Null(),
    ]),
    rainStartAt: Type.Union([UtcInstant, Type.Null()]),
    rainEndAt: Type.Union([UtcInstant, Type.Null()]),
    forecastUntil: UtcInstant,
  },
  { additionalProperties: false },
);
export type RainForecastData = Static<typeof RainForecastDataSchema>;
export const validRainForecastData = (
  value: unknown,
): value is RainForecastData => Value.Check(RainForecastDataSchema, value);

export const MINUTE_MS = 60_000;
/** Required future span (21.5) and the MVP provisional thresholds (21.4). */
export const REQUIRED_SLOTS = 60;
export const RAIN_THRESHOLD_MMH = 0.1;
const MERGE_GAP_SLOTS = 5; // a dry gap of 5 minutes or more splits the event
const MODERATE_MMH = 1.0;
const HEAVY_MMH = 10.0;
const MAX_INTERVALS = 500;

/** One interval as the Provider sent it. Nothing but the structure is checked
 * here: a slot is validated only if it becomes part of the adopted 60-slot
 * window (`requiredWindow`). Extra slots are not adopted and cannot make an
 * otherwise valid forecast fail (technology-stack 21.5).
 */
export interface Slot {
  readonly startTime: unknown;
  readonly value: unknown;
}

/** RFC 3339 with `Z` or a numeric offset (`+00:00` / `+0000`), normalized to
 * epoch ms. Anything else, including an impossible date, is rejected.
 */
export function parseInstant(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/.exec(
      text,
    );
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  const fraction = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  let offsetMs = 0;
  if (m[8] !== "Z") {
    const sign = m[8]![0] === "-" ? -1 : 1;
    const digits = m[8]!.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2));
    if (oh > 23 || om > 59) return null;
    offsetMs = sign * (oh * 60 + om) * MINUTE_MS;
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (new Date(utc).getUTCDate() !== day) return null; // e.g. Feb 30
  const result = utc + Math.round(fraction) - offsetMs;
  return Number.isSafeInteger(result) ? result : null;
}

/** The 1-minute timeline of a `/v4/timelines` response, or null when its
 * structure is not usable. Slot times and values are NOT validated here.
 */
export function slotsOf(body: unknown): Slot[] | null {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(body) || !isObject(body.data)) return null;
  const timelines = body.data.timelines;
  if (!Array.isArray(timelines)) return null;
  const timeline = timelines.find(
    (t): t is Record<string, unknown> => isObject(t) && t.timestep === "1m",
  );
  if (!timeline || !Array.isArray(timeline.intervals)) return null;
  if (timeline.intervals.length > MAX_INTERVALS) return null;
  return timeline.intervals.map((interval): Slot => {
    if (!isObject(interval)) return { startTime: undefined, value: undefined };
    const values = interval.values;
    return {
      startTime: interval.startTime,
      value: isObject(values) ? values.rainIntensity : undefined,
    };
  });
}

export type Window =
  | { ok: true; intensities: number[]; originMs: number }
  | { ok: false; reason: "invalid_response" | "stale_data" };

/** A slot start on the whole-minute grid, or null (unusable as a 1-minute
 * slot). An unusable slot is simply not a candidate for the window.
 */
const gridStart = (slot: Slot): number | null => {
  const ms = parseInstant(slot.startTime);
  return ms !== null && ms % MINUTE_MS === 0 ? ms : null;
};

/** The adopted span from the first whole minute at/after `atMs` (21.5): 60
 * consecutive slots, each exactly one minute after the previous one (no gap,
 * duplicate or reversal) and each a finite intensity >= 0. Only these slots
 * are validated; slots before or after them are ignored. If the origin slot
 * cannot be identified safely the forecast fails closed: no usable slot at all
 * or a gap at the origin is `invalid_response`; too few slots from the origin
 * is `stale_data`. No interpolation.
 */
export function requiredWindow(slots: readonly Slot[], atMs: number): Window {
  const originMs = Math.ceil(atMs / MINUTE_MS) * MINUTE_MS;
  let usable = 0;
  let first = -1;
  let firstMs = 0;
  for (let i = 0; i < slots.length; i++) {
    const ms = gridStart(slots[i]!);
    if (ms === null) continue; // not a candidate; ignored unless adopted
    usable++;
    if (ms >= originMs) {
      first = i;
      firstMs = ms;
      break;
    }
  }
  if (usable === 0 && slots.length > 0)
    return { ok: false, reason: "invalid_response" }; // no usable slot at all
  if (first < 0) return { ok: false, reason: "stale_data" };
  if (firstMs !== originMs) return { ok: false, reason: "invalid_response" }; // gap at the origin
  if (slots.length - first < REQUIRED_SLOTS)
    return { ok: false, reason: "stale_data" };
  const intensities: number[] = [];
  for (let i = 0; i < REQUIRED_SLOTS; i++) {
    const slot = slots[first + i]!;
    if (gridStart(slot) !== originMs + i * MINUTE_MS)
      return { ok: false, reason: "invalid_response" }; // gap, duplicate, reversed, bad time
    if (
      typeof slot.value !== "number" ||
      !Number.isFinite(slot.value) ||
      slot.value < 0
    )
      return { ok: false, reason: "invalid_response" };
    intensities.push(slot.value);
  }
  return { ok: true, intensities, originMs };
}

const iso = (ms: number) => new Date(ms).toISOString();
const classify = (maxMmH: number) =>
  maxMmH >= HEAVY_MMH ? "heavy" : maxMmH >= MODERATE_MMH ? "moderate" : "light";

/** Domain Data from a validated 60-slot window (21.3 / 21.4). The status is
 * the first slot's state; only the nearest event is described; nothing past
 * the window is guessed.
 */
export function rainForecastOf(window: {
  intensities: readonly number[];
  originMs: number;
}): RainForecastData {
  const { intensities, originMs } = window;
  const rain = intensities.map((v) => v >= RAIN_THRESHOLD_MMH);
  const forecastUntil = iso(originMs + intensities.length * MINUTE_MS);
  const raining = rain[0]!;
  const start = rain.indexOf(true);
  if (start < 0)
    return {
      status: "dry",
      intensity: null,
      rainStartAt: null,
      rainEndAt: null,
      forecastUntil,
    };
  // Extend the event over dry gaps shorter than 5 minutes.
  let last = start; // last rainy slot of the merged event
  let i = start;
  while (i < rain.length) {
    if (rain[i]) {
      last = i;
      i++;
      continue;
    }
    let gap = 0;
    while (i + gap < rain.length && !rain[i + gap]) gap++;
    const resumes = i + gap < rain.length;
    if (resumes && gap < MERGE_GAP_SLOTS) {
      i += gap; // same event
      continue;
    }
    break; // a 5+ minute dry run (confirmed or cut by the window end)
  }
  // Ends only when at least 5 consecutive dry slots follow within the window.
  let dryAfter = 0;
  while (last + 1 + dryAfter < rain.length && !rain[last + 1 + dryAfter])
    dryAfter++;
  const ended = dryAfter >= MERGE_GAP_SLOTS;
  const peak = Math.max(...intensities.slice(start, last + 1));
  return {
    status: raining ? "raining" : "dry",
    intensity: classify(peak),
    rainStartAt: raining ? null : iso(originMs + start * MINUTE_MS),
    rainEndAt: ended ? iso(originMs + (last + 1) * MINUTE_MS) : null,
    forecastUntil,
  };
}
