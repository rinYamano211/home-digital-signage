// 予定のDomain Data（docs/technology-stack.md 18.1）の型とRuntime Validation。
// 「今日」との照合・有効期限は表示時に現在時刻で評価する（schedule-state.ts）。
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  scheduleInstant,
  validDateString,
} from "../published-state/utc-instant";

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

/**
 * SchemaとSemantic Validation（technology-stack 18.1）：実在する日付、UTCの日時
 * （Backendの出力形式）、ID一意、開始 < 終了。「今日」との照合は表示時に行う。
 */
export function validScheduleShape(value: unknown): value is ScheduleData {
  if (!Value.Check(ScheduleDataSchema, value)) return false;
  if (!validDateString(value.date)) return false;
  const ids = new Set<string>();
  for (const event of value.events) {
    if (ids.has(event.id)) return false;
    ids.add(event.id);
    if (event.allDay) {
      if (
        !validDateString(event.startDate) ||
        !validDateString(event.endDateExclusive) ||
        !(event.startDate < event.endDateExclusive)
      )
        return false;
    } else {
      const start = scheduleInstant(event.startAt);
      const end = scheduleInstant(event.endAt);
      if (start === null || end === null || !(start < end)) return false;
    }
  }
  return true;
}
