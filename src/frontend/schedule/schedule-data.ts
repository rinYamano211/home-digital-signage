// 予定のDomain Data（docs/technology-stack.md 18.1）の型とRuntime Validation。
// 「今日」との照合・有効期限は表示時に現在時刻で評価する（schedule-state.ts）。
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const DateString = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const TimedEvent = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    title: Type.String(),
    allDay: Type.Literal(false),
    startAt: Type.String(),
    endAt: Type.String(),
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
const ScheduleDataSchema = Type.Object(
  {
    date: DateString,
    events: Type.Array(Type.Union([TimedEvent, AllDayEvent])),
  },
  { additionalProperties: false },
);
export type ScheduleData = Static<typeof ScheduleDataSchema>;
export type ScheduleEvent = ScheduleData["events"][number];
export type TimedScheduleEvent = Extract<ScheduleEvent, { allDay: false }>;
export type AllDayScheduleEvent = Extract<ScheduleEvent, { allDay: true }>;

/** SchemaとSemantic Validation（ID一意、開始 < 終了）。 */
export function validScheduleShape(value: unknown): value is ScheduleData {
  if (!Value.Check(ScheduleDataSchema, value)) return false;
  const ids = new Set<string>();
  for (const event of value.events) {
    if (ids.has(event.id)) return false;
    ids.add(event.id);
    if (event.allDay) {
      if (!(event.startDate < event.endDateExclusive)) return false;
    } else {
      const start = Date.parse(event.startAt);
      const end = Date.parse(event.endAt);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !(start < end))
        return false;
    }
  }
  return true;
}
