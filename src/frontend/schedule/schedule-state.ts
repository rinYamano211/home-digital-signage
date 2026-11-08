// 予定のComponent State（docs/frontend-development.md 11.4・11.5、UI設計 5.1・6.1・6.5）。
// Reactに依存しない純粋関数。Published Stateと現在時刻から導き、Backendへは戻さない。
import { DISPLAY_TIME_ZONE } from "../clock/format";
import type { PollingStatus } from "../published-state/polling";
import type { PublishedState } from "../published-state/schema";
import type {
  AllDayScheduleEvent,
  ScheduleData,
  TimedScheduleEvent,
} from "./schedule-data";

const DAY_MS = 86_400_000;
const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: DISPLAY_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** JSTの日付（YYYY-MM-DD）。 */
export function tokyoDate(ms: number): string {
  return dateFormatter.format(ms);
}
/** JSTの時刻（HH:MM）。 */
export function tokyoTime(ms: number): string {
  return timeFormatter.format(ms);
}
/** `YYYY-MM-DD` → `M/D`。 */
const monthDay = (date: string) =>
  `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
/** JSTの`date`の0時（ms）。Asia/Tokyoは夏時間がないためUTC+9で求める。 */
function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00+09:00`);
}
function nextDate(date: string, days = 1): string {
  return tokyoDate(dayStart(date) + days * DAY_MS + 12 * 3_600_000);
}

export type EventPhase = "ended" | "ongoing" | "upcoming";

export type TimedRow = {
  readonly id: string;
  /** 時刻欄。前日から続く予定は`前日`。 */
  readonly time: string;
  /** タイトル。空なら`（タイトルなし）`。 */
  readonly title: string;
  /** タイトルの後の終了表記。例：`（翌01:00まで）`。 */
  readonly until: string;
  readonly phase: EventPhase;
};
export type AllDayChip = {
  readonly id: string;
  readonly title: string;
  /** 最終日が明日以降なら`（11/9まで）`。 */
  readonly until: string;
};
export type ScheduleList = {
  readonly allDay: readonly AllDayChip[];
  readonly ended: readonly TimedRow[];
  /** 大きく表示する進行中（最大2件）。 */
  readonly ongoing: readonly TimedRow[];
  /** 大きく表示する次の予定（0か1件）。 */
  readonly next: TimedRow | null;
  /** 通常サイズ（3件目以降の進行中と、次の予定より後）。 */
  readonly later: readonly TimedRow[];
};

/** 取得失敗＋有効なデータ：`↻ 更新待ち・14:05時点`の時刻部分。 */
export type Staleness = { readonly since: string } | null;

export type ScheduleView =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "empty"; readonly stale: Staleness }
  | {
      readonly kind: "list";
      readonly stale: Staleness;
      readonly list: ScheduleList;
    };

/** 巡回に残すか（UI設計 6.2）。取得中・取得できないときは外す。 */
export function isScheduleDisplayable(view: ScheduleView): boolean {
  return view.kind === "empty" || view.kind === "list";
}

export function displayTitle(title: string): string {
  return title.trim() === "" ? "（タイトルなし）" : title;
}

/** 最終更新時刻の表記（UI設計 6.1）：同じ日は`14:05`、違う日は`11/1 23:50`。 */
export function staleSince(dataUpdatedAt: string, nowMs: number): string {
  const at = Date.parse(dataUpdatedAt);
  const time = tokyoTime(at);
  return tokyoDate(at) === tokyoDate(nowMs)
    ? time
    : `${monthDay(tokyoDate(at))} ${time}`;
}

/** 時刻指定の予定の時刻欄と終了表記（UI設計 5.1と、その補足）。 */
function timedRow(
  event: TimedScheduleEvent,
  today: string,
  nowMs: number,
): TimedRow {
  const start = Date.parse(event.startAt);
  const end = Date.parse(event.endAt);
  const todayStart = dayStart(today);
  const todayEnd = todayStart + DAY_MS;
  const fromYesterday = start < todayStart;
  const endDate = tokyoDate(end);
  let until = "";
  if (end > todayEnd) {
    // 翌日0:00ちょうどに終わる予定は当日中に終わるものとして表記しない。
    until =
      endDate === nextDate(today)
        ? `（翌${tokyoTime(end)}まで）`
        : `（${monthDay(endDate)} ${tokyoTime(end)}まで）`;
  } else if (fromYesterday) {
    until = `（${tokyoTime(end)}まで）`;
  }
  return {
    id: event.id,
    time: fromYesterday ? "前日" : tokyoTime(start),
    title: displayTitle(event.title),
    until,
    phase: end <= nowMs ? "ended" : start <= nowMs ? "ongoing" : "upcoming",
  };
}

const byStart = (a: TimedScheduleEvent, b: TimedScheduleEvent) =>
  Date.parse(a.startAt) - Date.parse(b.startAt) || compareId(a.id, b.id);
const byDate = (a: AllDayScheduleEvent, b: AllDayScheduleEvent) =>
  a.startDate < b.startDate
    ? -1
    : a.startDate > b.startDate
      ? 1
      : compareId(a.id, b.id);
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 予定一覧の組み立て。Backendの`events`の順は使わず、時刻指定は開始時刻→ID、
 * 終日は開始日→IDで並べる（更新のたびに入れ替わらないようにする。UI設計 5.1）。
 */
export function scheduleList(data: ScheduleData, nowMs: number): ScheduleList {
  const today = data.date;
  const timed = data.events
    .filter((e): e is TimedScheduleEvent => !e.allDay)
    .sort(byStart)
    .map((e) => timedRow(e, today, nowMs));
  const allDay = data.events
    .filter((e): e is AllDayScheduleEvent => e.allDay)
    .sort(byDate)
    .map((e) => {
      const lastDay = nextDate(e.endDateExclusive, -1);
      return {
        id: e.id,
        title: displayTitle(e.title),
        until: lastDay > today ? `（${monthDay(lastDay)}まで）` : "",
      };
    });
  const ended = timed.filter((r) => r.phase === "ended");
  const ongoing = timed.filter((r) => r.phase === "ongoing");
  const upcoming = timed.filter((r) => r.phase === "upcoming");
  return {
    allDay,
    ended,
    ongoing: ongoing.slice(0, 2),
    next: upcoming[0] ?? null,
    later: [...ongoing.slice(2), ...upcoming.slice(1)],
  };
}

/**
 * Published Stateから予定の表示状態を導く（frontend-development 11.4）。
 * 時刻が利用できない間の扱いは、巡回側の1枚表示（10.5）が優先する。
 */
export function scheduleView(
  state: PublishedState | undefined,
  polling: PollingStatus,
  nowMs: number,
): ScheduleView {
  if (state === undefined)
    return polling === "waiting"
      ? { kind: "loading" }
      : { kind: "unavailable" };
  const { data, meta } = state;
  if (data === null)
    return meta.lastAttemptAt === null
      ? { kind: "loading" }
      : { kind: "unavailable" };
  const schedule = data as ScheduleData; // 検証済み（published-state/schema.ts）
  if (
    meta.expiresAt === null ||
    !(nowMs < Date.parse(meta.expiresAt)) ||
    schedule.date !== tokyoDate(nowMs)
  )
    return { kind: "unavailable" };
  // `dataSource`は使わない（technology-stack 18.7）。
  const stale: Staleness =
    meta.lastAttemptResult === "failure" && meta.dataUpdatedAt !== null
      ? { since: staleSince(meta.dataUpdatedAt, nowMs) }
      : null;
  if (schedule.events.length === 0) return { kind: "empty", stale };
  return { kind: "list", stale, list: scheduleList(schedule, nowMs) };
}
