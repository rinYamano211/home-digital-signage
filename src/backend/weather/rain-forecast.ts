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

export interface Slot {
  /** Slot start, epoch ms (a whole minute). */
  readonly startMs: number;
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

/** The 1-minute timeline of a `/v4/timelines` response as ordered slots, or
 * null when the structure is not usable. Slot values are validated later,
 * only where required (21.5): extra slots are ignored.
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
  const slots: Slot[] = [];
  for (const interval of timeline.intervals) {
    if (!isObject(interval)) return null;
    const startMs = parseInstant(interval.startTime);
    // Whole-minute slot starts only; a timeline that is not on the minute grid
    // cannot be read as 1-minute slots and fails closed.
    if (startMs === null || startMs % MINUTE_MS !== 0) return null;
    const values = interval.values;
    slots.push({
      startMs,
      value: isObject(values) ? values.rainIntensity : undefined,
    });
  }
  return slots;
}

export type Window =
  | { ok: true; intensities: number[]; originMs: number }
  | { ok: false; reason: "invalid_response" | "stale_data" };

/** Required span from the first whole minute at/after `atMs` (21.5): 60
 * consecutive slots, strictly increasing by one minute, each a finite
 * intensity >= 0. Too few slots from the origin is `stale_data`; a broken
 * sequence or value is `invalid_response`. No interpolation.
 */
export function requiredWindow(slots: readonly Slot[], atMs: number): Window {
  const originMs = Math.ceil(atMs / MINUTE_MS) * MINUTE_MS;
  const first = slots.findIndex((s) => s.startMs >= originMs);
  if (first < 0 || slots.length - first < REQUIRED_SLOTS)
    return { ok: false, reason: "stale_data" };
  if (slots[first]!.startMs !== originMs)
    return { ok: false, reason: "invalid_response" }; // a gap at the origin
  const intensities: number[] = [];
  for (let i = 0; i < REQUIRED_SLOTS; i++) {
    const slot = slots[first + i]!;
    if (slot.startMs !== originMs + i * MINUTE_MS)
      return { ok: false, reason: "invalid_response" }; // gap, duplicate, reversed
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
