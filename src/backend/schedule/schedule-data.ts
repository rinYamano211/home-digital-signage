import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { tokyoDayStart } from "./jst.js";

/** Schedule Domain Data (technology-stack 18.1). */
const DateString = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const UtcInstant = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$",
});
const TimedEvent = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String(),
    allDay: Type.Literal(false),
    startAt: UtcInstant,
    endAt: UtcInstant,
  },
  { additionalProperties: false },
);
const AllDayEvent = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String(),
    allDay: Type.Literal(true),
    startDate: DateString,
    endDateExclusive: DateString,
  },
  { additionalProperties: false },
);
export const ScheduleDataSchema = Type.Object(
  {
    date: DateString,
    events: Type.Array(Type.Union([TimedEvent, AllDayEvent])),
  },
  { additionalProperties: false },
);
export type ScheduleData = Static<typeof ScheduleDataSchema>;
export type ScheduleEvent = ScheduleData["events"][number];

const DAY_MS = 86_400_000;
const instant = (value: string) => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value
    ? ms
    : null;
};

/** Schema plus Semantic Validation (18.1) for `targetDate`. */
export function validScheduleData(
  value: unknown,
  targetDate: string,
): value is ScheduleData {
  if (!Value.Check(ScheduleDataSchema, value)) return false;
  if (value.date !== targetDate) return false;
  const dayStart = tokyoDayStart(value.date);
  if (dayStart === null) return false;
  const dayEnd = dayStart + DAY_MS;
  const ids = new Set<string>();
  for (const event of value.events) {
    if (ids.has(event.id)) return false;
    ids.add(event.id);
    if (event.allDay) {
      if (
        tokyoDayStart(event.startDate) === null ||
        tokyoDayStart(event.endDateExclusive) === null ||
        !(event.startDate < event.endDateExclusive) ||
        !(event.startDate <= value.date && value.date < event.endDateExclusive)
      )
        return false;
    } else {
      const start = instant(event.startAt);
      const end = instant(event.endAt);
      if (
        start === null ||
        end === null ||
        !(start < end) ||
        !(start < dayEnd && end > dayStart)
      )
        return false;
    }
  }
  return true;
}
