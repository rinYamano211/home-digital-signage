// 検証画面の予定の合成データ（docs/frontend-development.md 11.7）。実際の予定は使わない。
// 現在時刻を基準に作るので、いつ開いても「進行中」「次の予定」が出る。
import type {
  PollingSnapshot,
  PollingStatus,
} from "../published-state/polling";
import type { PublishedState } from "../published-state/schema";
import type { ScheduleEvent } from "../schedule/schedule-data";
import { tokyoDate } from "../schedule/schedule-state";

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

function timed(
  id: string,
  title: string,
  start: number,
  end: number,
): ScheduleEvent {
  return { id, title, allDay: false, startAt: iso(start), endAt: iso(end) };
}
function allDay(
  id: string,
  title: string,
  start: string,
  endExclusive: string,
): ScheduleEvent {
  return {
    id,
    title,
    allDay: true,
    startDate: start,
    endDateExclusive: endExclusive,
  };
}
const dayOffset = (date: string, days: number) =>
  tokyoDate(Date.parse(`${date}T12:00:00+09:00`) + days * 24 * HOUR);

type Scenario = {
  readonly label: string;
  readonly state: (now: number) => PublishedState | undefined;
};

function ok(
  now: number,
  events: ScheduleEvent[],
  extra: Partial<PublishedState["meta"]> = {},
  date = tokyoDate(now),
): PublishedState {
  return {
    data: { date, events },
    meta: {
      dataUpdatedAt: iso(now - 5 * MIN),
      expiresAt: iso(now + 6 * HOUR),
      lastAttemptAt: iso(now - 5 * MIN),
      lastAttemptResult: "success",
      publishedAt: iso(now - 5 * MIN),
      dataSource: "externalApi",
      ...extra,
    },
  };
}
const nullState = (lastAttemptAt: string | null): PublishedState => ({
  data: null,
  meta: {
    dataUpdatedAt: null,
    expiresAt: null,
    lastAttemptAt,
    lastAttemptResult: lastAttemptAt === null ? null : "failure",
    publishedAt: lastAttemptAt ?? iso(Date.now()),
    dataSource: null,
  },
});

function usual(now: number): ScheduleEvent[] {
  const today = tokyoDate(now);
  return [
    allDay("d1", "資源ごみの日", today, dayOffset(today, 1)),
    timed("e1", "ゴミ出し", now - 4 * HOUR, now - 4 * HOUR + 15 * MIN),
    timed("e2", "朝の散歩", now - 3 * HOUR, now - 2 * HOUR),
    timed("e3", "オンライン会議", now - 30 * MIN, now + 30 * MIN),
    timed("e4", "買い物", now + 1 * HOUR, now + 2 * HOUR),
    timed("e5", "夕食の準備", now + 3 * HOUR, now + 4 * HOUR),
    timed("e6", "ピアノの練習", now + 5 * HOUR, now + 6 * HOUR),
  ];
}

export const SCHEDULE_SCENARIOS: readonly Scenario[] = [
  { label: "通常", state: (now) => ok(now, usual(now)) },
  {
    label: "多件（集約・ほか N件）",
    state: (now) =>
      ok(now, [
        ...usual(now),
        ...Array.from({ length: 6 }, (_, i) =>
          timed(
            `x${i}`,
            `終わった予定 ${i + 1}`,
            now - (10 - i) * 20 * MIN,
            now - (10 - i) * 20 * MIN + 10 * MIN,
          ),
        ),
        ...Array.from({ length: 8 }, (_, i) =>
          timed(
            `y${i}`,
            `あとの予定 ${i + 1}`,
            now + (7 + i) * 20 * MIN,
            now + (7 + i) * 20 * MIN + 15 * MIN,
          ),
        ),
      ]),
  },
  {
    label: "日付またぎ・複数日",
    state: (now) => {
      const today = tokyoDate(now);
      const start = Date.parse(`${today}T00:00:00+09:00`);
      return ok(now, [
        allDay("m1", "旅行", dayOffset(today, -1), dayOffset(today, 2)),
        timed("c1", "夜勤", start - 2 * HOUR, now + 30 * MIN),
        timed("c2", "前日からの作業", start - HOUR, start + 30 * MIN),
        timed("c3", "深夜の作業", start + 23 * HOUR, start + 25 * HOUR),
        timed(
          "c4",
          "出張",
          start + 22 * HOUR,
          start + 3 * 24 * HOUR + 10 * HOUR,
        ),
        timed("c5", "24時まで", start + 23 * HOUR, start + 24 * HOUR),
      ]);
    },
  },
  {
    label: "同時刻・長いタイトル・タイトルなし",
    state: (now) =>
      ok(now, [
        timed("s2", "同時刻の予定（B）", now + HOUR, now + 2 * HOUR),
        timed("s1", "同時刻の予定（A）", now + HOUR, now + 2 * HOUR),
        timed(
          "s3",
          "とても長いタイトルの予定が一行に収まらない場合は末尾を省略して表示します",
          now + 3 * HOUR,
          now + 4 * HOUR,
        ),
        timed("s4", "   ", now + 5 * HOUR, now + 6 * HOUR),
      ]),
  },
  { label: "予定なし", state: (now) => ok(now, []) },
  {
    label: "更新待ち",
    state: (now) =>
      ok(now, usual(now), {
        dataUpdatedAt: iso(now - 40 * MIN),
        lastAttemptAt: iso(now - MIN),
        lastAttemptResult: "failure",
        dataSource: "cache",
      }),
  },
  { label: "取得中", state: () => nullState(null) },
  { label: "取得できません", state: (now) => nullState(iso(now - MIN)) },
  {
    label: "期限切れ",
    state: (now) => ok(now, usual(now), { expiresAt: iso(now - MIN) }),
  },
  {
    label: "前日のデータ",
    state: (now) => ok(now, usual(now), {}, dayOffset(tokyoDate(now), -1)),
  },
  { label: "未公開（Stateなし）", state: () => undefined },
];

export const POLLING_STATUSES: readonly PollingStatus[] = [
  "received",
  "waiting",
  "neverReceived",
];

export function scenarioSnapshot(
  scenario: number,
  status: PollingStatus,
  now: number,
): PollingSnapshot {
  const state =
    status === "received"
      ? SCHEDULE_SCENARIOS[scenario]?.state(now)
      : undefined;
  return { status, states: state ? { schedule: state } : {}, at: now };
}
