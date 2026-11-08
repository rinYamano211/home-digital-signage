// Issue #10 Schedule Domain: JST dates, events.list normalization and the
// Schedule Domain Data validation (technology-stack 18.1・18.2・18.7).
// Synthetic data only.
import { expect, test } from "vitest";
import {
  addDays,
  nextTokyoMidnight,
  tokyoDate,
  tokyoDayStart,
} from "../../src/backend/schedule/jst.js";
import {
  eventsUrl,
  normalizeEvents,
  parseEventsPage,
} from "../../src/backend/schedule/google-calendar.js";
import { validScheduleData } from "../../src/backend/schedule/schedule-data.js";

const at = (iso: string) => Date.parse(iso);
const day = "2026-11-08";

test("JST date boundaries use UTC+9", () => {
  expect(tokyoDate(at("2026-11-07T14:59:59.999Z"))).toBe("2026-11-07");
  expect(tokyoDate(at("2026-11-07T15:00:00.000Z"))).toBe("2026-11-08");
  expect(tokyoDayStart(day)).toBe(at("2026-11-07T15:00:00Z"));
  expect(nextTokyoMidnight(at("2026-11-08T14:55:00Z"))).toBe(
    at("2026-11-08T15:00:00Z"),
  );
  // Exactly at midnight, the next midnight is a full day later.
  expect(nextTokyoMidnight(at("2026-11-07T15:00:00Z"))).toBe(
    at("2026-11-08T15:00:00Z"),
  );
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  for (const bad of ["2026-02-30", "2026-13-01", "26-11-08", "2026-11-8"])
    expect(tokyoDayStart(bad)).toBeNull();
});

test("events.list URL: JST day range, single events, fields and paging", () => {
  const url = new URL(eventsUrl("team@example.test", day, "next-page"));
  expect(url.origin + url.pathname).toBe(
    "https://www.googleapis.com/calendar/v3/calendars/team%40example.test/events",
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    singleEvents: "true",
    orderBy: "startTime",
    showDeleted: "false",
    maxResults: "250",
    timeMin: "2026-11-08T00:00:00+09:00",
    timeMax: "2026-11-09T00:00:00+09:00",
    fields: "items(id,status,summary,start,end),nextPageToken",
    pageToken: "next-page",
  });
  expect(new URL(eventsUrl("x", day)).searchParams.has("pageToken")).toBe(
    false,
  );
});

test("page parsing validates the Google response before normalization", () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  expect(parseEventsPage(enc({ items: [], nextPageToken: "t" }))).toEqual({
    items: [],
    nextPageToken: "t",
  });
  expect(parseEventsPage(enc({}))).toEqual({});
  expect(parseEventsPage(enc({ items: [{ summary: "no id" }] }))).toBeNull();
  expect(parseEventsPage(enc({ items: "x" }))).toBeNull();
  expect(parseEventsPage(new TextEncoder().encode("{"))).toBeNull();
  expect(parseEventsPage(new Uint8Array([0xff, 0xfe]))).toBeNull();
});

const timed = (id: string, start: string, end: string, extra = {}) => ({
  id,
  start: { dateTime: start },
  end: { dateTime: end },
  ...extra,
});
const allDay = (id: string, start: string, end: string, extra = {}) => ({
  id,
  start: { date: start },
  end: { date: end },
  ...extra,
});

test("normalization: timed to UTC, all-day exclusive end, carry-over and cancelled", () => {
  expect(
    normalizeEvents(
      [
        timed("a", "2026-11-08T09:00:00+09:00", "2026-11-08T10:00:00+09:00", {
          summary: "Meeting",
          status: "confirmed",
        }),
        // From the previous day, still running today (18.3).
        timed("b", "2026-11-07T23:00:00+09:00", "2026-11-08T01:00:00+09:00", {
          summary: "Night",
        }),
        // Until tomorrow.
        timed("c", "2026-11-08T23:00:00+09:00", "2026-11-09T01:00:00+09:00"),
        allDay("d", day, "2026-11-09", { summary: "Holiday" }),
        allDay("e", "2026-11-07", "2026-11-10", { summary: "Trip" }),
        // Cancelled is dropped before any date validation.
        { id: "x", status: "cancelled" },
        // Tentative events are kept (18.2).
        timed("t", "2026-11-08T12:00:00Z", "2026-11-08T12:30:00Z", {
          status: "tentative",
        }),
      ],
      day,
    ),
  ).toEqual([
    {
      id: "a",
      title: "Meeting",
      allDay: false,
      startAt: "2026-11-08T00:00:00.000Z",
      endAt: "2026-11-08T01:00:00.000Z",
    },
    {
      id: "b",
      title: "Night",
      allDay: false,
      startAt: "2026-11-07T14:00:00.000Z",
      endAt: "2026-11-07T16:00:00.000Z",
    },
    {
      id: "c",
      title: "",
      allDay: false,
      startAt: "2026-11-08T14:00:00.000Z",
      endAt: "2026-11-08T16:00:00.000Z",
    },
    {
      id: "d",
      title: "Holiday",
      allDay: true,
      startDate: day,
      endDateExclusive: "2026-11-09",
    },
    {
      id: "e",
      title: "Trip",
      allDay: true,
      startDate: "2026-11-07",
      endDateExclusive: "2026-11-10",
    },
    {
      id: "t",
      title: "",
      allDay: false,
      startAt: "2026-11-08T12:00:00.000Z",
      endAt: "2026-11-08T12:30:00.000Z",
    },
  ]);
});

test("normalization excludes events that do not overlap the target day", () => {
  expect(
    normalizeEvents(
      [
        // Ends exactly at today's 00:00: yesterday only.
        timed("y", "2026-11-07T23:00:00+09:00", "2026-11-08T00:00:00+09:00"),
        allDay("z", "2026-11-07", day),
        timed("n", "2026-11-09T00:00:00+09:00", "2026-11-09T01:00:00+09:00"),
      ],
      day,
    ),
  ).toEqual([]);
});

test.each([
  [
    "duplicate ID",
    [allDay("a", day, "2026-11-09"), allDay("a", day, "2026-11-09")],
  ],
  ["missing start", [{ id: "a", end: { date: "2026-11-09" } }]],
  [
    "mixed date and dateTime",
    [
      {
        id: "a",
        start: { date: day },
        end: { dateTime: "2026-11-08T10:00:00Z" },
      },
    ],
  ],
  ["no offset", [timed("a", "2026-11-08T09:00:00", "2026-11-08T10:00:00")]],
  [
    "end before start",
    [timed("a", "2026-11-08T10:00:00Z", "2026-11-08T09:00:00Z")],
  ],
  ["zero-length all-day", [allDay("a", day, day)]],
  ["invalid date", [allDay("a", "2026-02-30", "2026-03-01")]],
])("a malformed event fails the whole attempt: %s", (_name, items) => {
  expect(normalizeEvents(items, day)).toBeNull();
});

test("Schedule Domain Data: schema and semantic validation (18.1)", () => {
  const event = {
    id: "a",
    title: "",
    allDay: false,
    startAt: "2026-11-08T00:00:00.000Z",
    endAt: "2026-11-08T01:00:00.000Z",
  };
  expect(validScheduleData({ date: day, events: [] }, day)).toBe(true);
  expect(validScheduleData({ date: day, events: [event] }, day)).toBe(true);
  expect(validScheduleData({ date: day, events: [] }, "2026-11-09")).toBe(
    false,
  );
  expect(validScheduleData({ date: day, events: [event, event] }, day)).toBe(
    false,
  );
  expect(
    validScheduleData({ date: day, events: [{ ...event, extra: 1 }] }, day),
  ).toBe(false);
  expect(
    validScheduleData(
      {
        date: day,
        events: [
          {
            ...event,
            startAt: "2026-11-09T00:00:00.000Z",
            endAt: "2026-11-09T01:00:00.000Z",
          },
        ],
      },
      day,
    ),
  ).toBe(false);
  expect(validScheduleData({ date: day, events: null }, day)).toBe(false);
});
