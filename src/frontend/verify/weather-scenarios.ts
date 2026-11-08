// 検証画面の天気の合成データ（docs/frontend-development.md 12.7）。実際の地点・天気は使わない。
// 現在時刻を基準に作る。日付またぎ・夜は、表示の評価に使う時刻だけを今日の決まった時刻にする
// （`evaluateAt`。時計の表示は変えない）。
import type { PublishedState, StateKey } from "../published-state/schema";
import { tokyoDate } from "../schedule/schedule-state";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const dayStart = (date: string) => Date.parse(`${date}T00:00:00+09:00`);
const nextHour = (ms: number) => Math.ceil(ms / HOUR) * HOUR;

type WeatherStates = Partial<Record<StateKey, PublishedState>>;
type Options = {
  readonly hours?: number;
  readonly days?: number;
  readonly code?: number;
  readonly isDay?: boolean;
};

function meta(now: number, ttl: number): PublishedState["meta"] {
  return {
    dataUpdatedAt: iso(now - 5 * MIN),
    expiresAt: iso(now + ttl),
    lastAttemptAt: iso(now - 5 * MIN),
    lastAttemptResult: "success",
    publishedAt: iso(now - 5 * MIN),
    dataSource: "externalApi",
  };
}

/** 合成の3State。時間別は次の正時から、週間は今日から。 */
function weather(now: number, options: Options = {}): WeatherStates {
  const { hours = 36, days = 9, code, isDay = true } = options;
  const first = nextHour(now);
  const today = dayStart(tokyoDate(now));
  return {
    currentWeather: {
      data: {
        temperatureC: 17.6,
        weatherCode: code ?? 3,
        isDay,
        validAt: iso(Math.floor(now / (15 * MIN)) * 15 * MIN),
      },
      meta: meta(now, 2 * HOUR),
    },
    hourlyWeather: {
      data: {
        hours: Array.from({ length: hours }, (_, i) => ({
          validAt: iso(first + i * HOUR),
          temperatureC: 18 - Math.abs(6 - i) * 0.7,
          weatherCode: code ?? [0, 1, 2, 3, 61, 80, 3, 2][i % 8]!,
          precipitationProbability: [10, 20, 40, 60, 80, 50, 30, 0][i % 8]!,
        })),
      },
      meta: meta(now, 2 * HOUR),
    },
    weeklyWeather: {
      data: {
        days: Array.from({ length: days }, (_, i) => ({
          date: tokyoDate(today + i * DAY + 12 * HOUR),
          weatherCode: code ?? [61, 2, 3, 0, 71, 95, 45, 1, 3][i % 9]!,
          temperatureMaxC: 19 + (i % 4),
          temperatureMinC: 9 + (i % 3),
          precipitationProbability: [70, 30, 20, 0, 60, 90, 40, 10, 20][i % 9]!,
        })),
      },
      meta: meta(now, 12 * HOUR),
    },
  };
}

function mapStates(
  states: WeatherStates,
  f: (state: PublishedState) => PublishedState,
): WeatherStates {
  return Object.fromEntries(
    Object.entries(states).map(([key, state]) => [key, f(state)]),
  );
}

const noData = (lastAttemptAt: string | null): PublishedState => ({
  data: null,
  meta: {
    dataUpdatedAt: null,
    expiresAt: null,
    lastAttemptAt,
    lastAttemptResult: lastAttemptAt === null ? null : "failure",
    publishedAt: iso(Date.now()),
    dataSource: null,
  },
});
const allNoData = (lastAttemptAt: string | null): WeatherStates => ({
  currentWeather: noData(lastAttemptAt),
  hourlyWeather: noData(lastAttemptAt),
  weeklyWeather: noData(lastAttemptAt),
});

type Scenario = {
  readonly label: string;
  readonly states: (now: number) => WeatherStates;
  /** 表示の評価に使う時刻（省略時は現在時刻）。 */
  readonly evaluateAt?: (now: number) => number;
};

const at = (hour: number) => (now: number) =>
  dayStart(tokyoDate(now)) + hour * HOUR;

export const WEATHER_SCENARIOS: readonly Scenario[] = [
  { label: "正常", states: (now) => weather(now) },
  {
    label: "更新待ち",
    states: (now) =>
      mapStates(weather(now), (s) => ({
        ...s,
        meta: {
          ...s.meta,
          dataUpdatedAt: iso(now - 40 * MIN),
          lastAttemptAt: iso(now - MIN),
          lastAttemptResult: "failure",
          dataSource: "cache",
        },
      })),
  },
  { label: "取得中", states: () => allNoData(null) },
  { label: "取得できません", states: (now) => allNoData(iso(now - MIN)) },
  {
    label: "期限切れ",
    states: (now) =>
      mapStates(weather(now), (s) => ({
        ...s,
        meta: { ...s.meta, expiresAt: iso(now - MIN) },
      })),
  },
  {
    label: "時間別の日付またぎ（18:30として評価）",
    states: (now) => weather(now),
    evaluateAt: (now) => at(18)(now) + 30 * MIN,
  },
  {
    label: "時間別の枠の不足（5枠）",
    states: (now) => weather(now, { hours: 5 }),
  },
  {
    label: "週間の日数不足（3日）",
    states: (now) => weather(now, { days: 3 }),
  },
  {
    label: "未知の天気コード",
    states: (now) => weather(now, { code: 100 }),
  },
  {
    label: "夜（21:00として評価）",
    states: (now) => weather(now, { code: 0, isDay: false }),
    evaluateAt: at(21),
  },
  {
    label: "現在の天気だけ取得できません",
    states: (now) => ({
      ...weather(now),
      currentWeather: noData(iso(now - MIN)),
    }),
  },
];

/** 選んだシナリオの3Stateと、表示の評価に使う時刻。 */
export function weatherScenario(
  index: number,
  now: number,
): { readonly states: WeatherStates; readonly at: number } {
  const scenario = WEATHER_SCENARIOS[index] ?? WEATHER_SCENARIOS[0]!;
  const evaluated = scenario.evaluateAt?.(now) ?? now;
  return { states: scenario.states(evaluated), at: evaluated };
}
