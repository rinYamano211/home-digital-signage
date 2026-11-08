import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { addDays, tokyoDayStart, tokyoDayStartRfc3339 } from "./jst.js";
import type { ScheduleEvent } from "./schedule-data.js";

/** Google Calendar events.list (technology-stack 18.2・18.7). */
export const EVENTS_PAGE_SIZE = 250;
export const MAX_PAGES = 10;
const FIELDS = "items(id,status,summary,start,end),nextPageToken";

export function eventsUrl(
  calendarId: string,
  targetDate: string,
  pageToken?: string,
): string {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  const query = url.searchParams;
  query.set("singleEvents", "true");
  query.set("orderBy", "startTime");
  query.set("showDeleted", "false");
  query.set("maxResults", String(EVENTS_PAGE_SIZE));
  query.set("timeMin", tokyoDayStartRfc3339(targetDate));
  query.set("timeMax", tokyoDayStartRfc3339(addDays(targetDate, 1)));
  query.set("fields", FIELDS);
  if (pageToken !== undefined) query.set("pageToken", pageToken);
  return url.href;
}

// Only the fields requested above. Unknown fields are tolerated (Google may
// add some); the normalized Domain Data never carries them.
const EventTime = Type.Object({
  date: Type.Optional(Type.String()),
  dateTime: Type.Optional(Type.String()),
});
const GoogleEvent = Type.Object({
  id: Type.String({ minLength: 1 }),
  status: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  start: Type.Optional(EventTime),
  end: Type.Optional(EventTime),
});
export const EventsPageSchema = Type.Object({
  items: Type.Optional(Type.Array(GoogleEvent)),
  nextPageToken: Type.Optional(Type.String({ minLength: 1 })),
});
export type EventsPage = Static<typeof EventsPageSchema>;
type GoogleEventItem = Static<typeof GoogleEvent>;

export function parseEventsPage(body: Uint8Array): EventsPage | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  return Value.Check(EventsPageSchema, value) ? value : null;
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Epoch ms of an RFC 3339 date-time with an offset, or null. Date.parse
 * alone rolls over non-existent values (2026-02-30, 24:00), so every field is
 * range-checked first and the calendar date must exist. Leap seconds (:60)
 * are rejected.
 */
export function rfc3339Instant(value: string): number | null {
  const m = RFC3339.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (hour! > 23 || minute! > 59 || second! > 59) return null;
  if (m[8] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59))
    return null;
  const utc = new Date(Date.UTC(year!, month! - 1, day!));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month! - 1 ||
    utc.getUTCDate() !== day
  )
    return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
const DAY_MS = 86_400_000;

/** Normalizes all pages of one attempt (18.2). Returns null when any
 * non-cancelled event is malformed or an ID repeats: the whole attempt fails.
 */
export function normalizeEvents(
  items: readonly GoogleEventItem[],
  targetDate: string,
): ScheduleEvent[] | null {
  const dayStart = tokyoDayStart(targetDate);
  if (dayStart === null) return null;
  const dayEnd = dayStart + DAY_MS;
  const ids = new Set<string>();
  const events: ScheduleEvent[] = [];
  for (const item of items) {
    // Cancelled events are dropped before any date validation (18.2).
    if (item.status === "cancelled") continue;
    if (ids.has(item.id)) return null;
    ids.add(item.id);
    const title = item.summary ?? "";
    const start = item.start;
    const end = item.end;
    if (!start || !end) return null;
    if (start.dateTime !== undefined || end.dateTime !== undefined) {
      if (start.dateTime === undefined || end.dateTime === undefined)
        return null;
      if (start.date !== undefined || end.date !== undefined) return null;
      const from = rfc3339Instant(start.dateTime);
      const to = rfc3339Instant(end.dateTime);
      if (from === null || to === null || !(from < to)) return null;
      if (!(from < dayEnd && to > dayStart)) continue; // not on the target day
      events.push({
        id: item.id,
        title,
        allDay: false,
        startAt: new Date(from).toISOString(),
        endAt: new Date(to).toISOString(),
      });
    } else {
      if (start.date === undefined || end.date === undefined) return null;
      if (
        tokyoDayStart(start.date) === null ||
        tokyoDayStart(end.date) === null ||
        !(start.date < end.date)
      )
        return null;
      // end.date is exclusive (17.2).
      if (!(start.date <= targetDate && targetDate < end.date)) continue;
      events.push({
        id: item.id,
        title,
        allDay: true,
        startDate: start.date,
        endDateExclusive: end.date,
      });
    }
  }
  return events;
}
