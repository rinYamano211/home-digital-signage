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
  /**
   * 収まりの確認用の、一番幅を取る値（Issue #98）。現在 -10°、時間別 -10〜-12°・100%、
   * 最高 -10°台・最低 -15°台。
   */
  readonly cold?: boolean;
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
  const { hours = 36, days = 9, code, isDay = true, cold = false } = options;
  const first = nextHour(now);
  const today = dayStart(tokyoDate(now));
  return {
    currentWeather: {
      data: {
        temperatureC: cold ? -10.4 : 17.6,
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
          temperatureC: cold ? -10 - (i % 3) * 0.9 : 18 - Math.abs(6 - i) * 0.7,
          weatherCode: code ?? [0, 1, 2, 3, 61, 80, 3, 2][i % 8]!,
          precipitationProbability: cold
            ? 100
            : [10, 20, 40, 60, 80, 50, 30, 0][i % 8]!,
        })),
      },
      meta: meta(now, 2 * HOUR),
    },
    rainForecast: rainState(now, {
      status: "dry",
      intensity: null,
      rainStartAt: null,
      rainEndAt: null,
      forecastUntil: iso(now + 60 * MIN),
    }),
    weeklyWeather: {
      data: {
        days: Array.from({ length: days }, (_, i) => ({
          date: tokyoDate(today + i * DAY + 12 * HOUR),
          weatherCode: code ?? [61, 2, 3, 0, 71, 95, 45, 1, 3][i % 9]!,
          temperatureMaxC: cold ? -10 - (i % 4) : 19 + (i % 4),
          temperatureMinC: cold ? -15 - (i % 3) : 9 + (i % 3),
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

/** 降雨の合成State。`age`分前に取得し、`failure`なら直近の取得は失敗。 */
function rainState(
  now: number,
  data: Record<string, unknown>,
  age = 5,
  failure = false,
): PublishedState {
  return {
    data,
    meta: {
      dataUpdatedAt: iso(now - age * MIN),
      expiresAt: iso(now + 30 * MIN - age * MIN),
      lastAttemptAt: iso(now - (failure ? 1 : age) * MIN),
      lastAttemptResult: failure ? "failure" : "success",
      publishedAt: iso(now - age * MIN),
      dataSource: failure ? "cache" : "externalApi",
    },
  };
}
const until = (now: number) => iso(now + 60 * MIN);
const withRain = (now: number, state: PublishedState): WeatherStates => ({
  ...weather(now),
  rainForecast: state,
});

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

/** 取得に失敗し、前日に取得したデータが残っている（札に日付が付く：`11/20 21:00時点`）。 */
const staleFromYesterday =
  (now: number) =>
  (state: PublishedState): PublishedState => ({
    ...state,
    meta: {
      ...state.meta,
      dataUpdatedAt: iso(now - 25 * HOUR),
      lastAttemptAt: iso(now - MIN),
      lastAttemptResult: "failure",
      dataSource: "cache",
    },
  });

/**
 * 収まりが一番厳しい組合せ（Issue #98）：現在 -10°・天気不明・最高最低あり、
 * 現在と時間別がともに日付付きの更新待ち。降雨帯は`rain`で切り替える。
 */
function tightest(now: number, rain: PublishedState): WeatherStates {
  const states = weather(now, { cold: true, code: 100 });
  const stale = staleFromYesterday(now);
  return {
    ...states,
    currentWeather: stale(states.currentWeather!),
    hourlyWeather: stale(states.hourlyWeather!),
    rainForecast: rain,
  };
}

/** Issue #98の確認に使う降雨帯の状態。帯の高さが変わる状態をすべて含める（#105）。 */
const TIGHTEST_RAINS: readonly (readonly [
  string,
  (now: number) => PublishedState,
])[] = [
  [
    "降り始め・更新待ち",
    (now) =>
      rainState(
        now,
        {
          status: "dry",
          intensity: "light",
          rainStartAt: iso(now + 20 * MIN),
          rainEndAt: null,
          forecastUntil: until(now),
        },
        7,
        true,
      ),
  ],
  [
    "降り始め",
    (now) =>
      rainState(now, {
        status: "dry",
        intensity: "light",
        rainStartAt: iso(now + 20 * MIN),
        rainEndAt: iso(now + 45 * MIN),
        forecastUntil: until(now),
      }),
  ],
  [
    "降雨中・やむ見込みあり",
    (now) =>
      rainState(now, {
        status: "raining",
        intensity: "moderate",
        rainStartAt: null,
        rainEndAt: iso(now + 30 * MIN),
        forecastUntil: until(now),
      }),
  ],
  [
    "雨の予報なし",
    (now) =>
      rainState(now, {
        status: "dry",
        intensity: null,
        rainStartAt: null,
        rainEndAt: null,
        forecastUntil: until(now),
      }),
  ],
  [
    "予報時刻を過ぎた",
    (now) =>
      rainState(
        now,
        {
          status: "dry",
          intensity: "light",
          rainStartAt: iso(now - 2 * MIN),
          rainEndAt: null,
          forecastUntil: until(now),
        },
        8,
      ),
  ],
  [
    "取得から15分（更新待ち）",
    (now) =>
      rainState(
        now,
        {
          status: "dry",
          intensity: "light",
          rainStartAt: iso(now + 20 * MIN),
          rainEndAt: null,
          forecastUntil: until(now),
        },
        15,
        true,
      ),
  ],
  ["取得できません", (now) => noData(iso(now - MIN))],
];

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
    label: "時間別の日付またぎ（18:30として評価。明日 0時が上段の末尾）",
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
    label: "降雨：20分後に弱い雨（降り始め）",
    states: (now) =>
      withRain(
        now,
        rainState(now, {
          status: "dry",
          intensity: "light",
          rainStartAt: iso(now + 20 * MIN),
          rainEndAt: iso(now + 45 * MIN),
          forecastUntil: until(now),
        }),
      ),
  },
  {
    label: "降雨：まもなく強い雨",
    states: (now) =>
      withRain(
        now,
        rainState(now, {
          status: "dry",
          intensity: "heavy",
          rainStartAt: iso(now + 3 * MIN),
          rainEndAt: null,
          forecastUntil: until(now),
        }),
      ),
  },
  {
    label: "降雨：降雨中・やむ見込みあり",
    states: (now) =>
      withRain(
        now,
        rainState(now, {
          status: "raining",
          intensity: "moderate",
          rainStartAt: null,
          rainEndAt: iso(now + 30 * MIN),
          forecastUntil: until(now),
        }),
      ),
  },
  {
    label: "降雨：降雨中・終了不明",
    states: (now) =>
      withRain(
        now,
        rainState(now, {
          status: "raining",
          intensity: "light",
          rainStartAt: null,
          rainEndAt: null,
          forecastUntil: until(now),
        }),
      ),
  },
  {
    label: "降雨：直近の取得が失敗（更新待ちの札）",
    states: (now) =>
      withRain(
        now,
        rainState(
          now,
          {
            status: "dry",
            intensity: "light",
            rainStartAt: iso(now + 20 * MIN),
            rainEndAt: null,
            forecastUntil: until(now),
          },
          7,
          true,
        ),
      ),
  },
  {
    label: "降雨：取得から15分（予報を隠す）",
    states: (now) =>
      withRain(
        now,
        rainState(
          now,
          {
            status: "dry",
            intensity: "light",
            rainStartAt: iso(now + 20 * MIN),
            rainEndAt: null,
            forecastUntil: until(now),
          },
          15,
          true,
        ),
      ),
  },
  {
    label: "降雨：予報時刻を過ぎた",
    states: (now) =>
      withRain(
        now,
        rainState(
          now,
          {
            status: "dry",
            intensity: "light",
            rainStartAt: iso(now - 2 * MIN),
            rainEndAt: null,
            forecastUntil: until(now),
          },
          8,
        ),
      ),
  },
  {
    label: "降雨だけ取得できません",
    states: (now) => ({
      ...weather(now),
      rainForecast: noData(iso(now - MIN)),
    }),
  },
  {
    label: "現在の天気だけ取得できません",
    states: (now) => ({
      ...weather(now),
      currentWeather: noData(iso(now - MIN)),
    }),
  },
  // Issue #98：`明日 0時`の位置と、正時・JST 0時の前後（上段の末尾は上の18:30）。
  {
    label: "#98 明日 0時が先頭（23:59として評価）",
    states: (now) => weather(now),
    evaluateAt: (now) => at(23)(now) + 59 * MIN,
  },
  {
    label: "#98 0時ちょうど（00:00として評価）",
    states: (now) => weather(now),
    evaluateAt: at(0),
  },
  {
    label: "#98 明日 0時が下段の先頭（17:30として評価）",
    states: (now) => weather(now),
    evaluateAt: (now) => at(17)(now) + 30 * MIN,
  },
  {
    label: "#98 明日 0時が段の途中（21:30として評価）",
    states: (now) => weather(now),
    evaluateAt: (now) => at(21)(now) + 30 * MIN,
  },
  {
    label: "#98 負の気温・100%・12枠未満（5枠）",
    states: (now) => weather(now, { cold: true, hours: 5 }),
  },
  // Issue #98：収まりが一番厳しい組合せ×降雨帯の各状態。
  ...TIGHTEST_RAINS.map(([name, rain]) => ({
    label: `#98 最も厳しい組合せ＋降雨：${name}`,
    states: (now: number) => tightest(now, rain(now)),
  })),
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
