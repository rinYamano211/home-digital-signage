// 天気のComponent State（docs/frontend-development.md 12.3〜12.5、UI設計 5.2〜5.4・6.1・6.2・6.5）。
// Reactに依存しない純粋関数。Published Stateと現在時刻から導き、Backendへは戻さない。
// 時刻の表記・最終更新時刻の表記は、予定と同じ規則を使う（12.2）。
import type { PollingStatus } from "../published-state/polling";
import type { PublishedState } from "../published-state/schema";
import {
  staleSince,
  tokyoDate,
  tokyoTime,
  type Staleness,
} from "../schedule/schedule-state";
import type {
  CurrentWeatherData,
  HourlyWeatherData,
  RainForecastData,
  WeeklyWeatherData,
} from "./weather-data";

const HOUR_MS = 3_600_000;
const JST_OFFSET_MS = 9 * HOUR_MS;
/** 時間別の表示枠数（UI設計 5.2）と、週間の表示日数（5.3）。 */
export const HOURLY_SLOTS = 12;
export const WEEKLY_DAYS = 7;
/** 降水確率をこの値以上なら雨の色で強調する（UI設計 5.2・5.3）。 */
const WET_PERCENT = 50;

/** 天気コードの区分（UI設計 5.4）。 */
export type WeatherCategory =
  "clear" | "cloudy" | "fog" | "rain" | "snow" | "storm" | "unknown";

export function weatherCategory(code: number): WeatherCategory {
  if (code === 0 || code === 1) return "clear";
  if (code === 2 || code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95 && code <= 99) return "storm";
  return "unknown";
}

/** 天気名（frontend-development 12.4）。未知のコードは`天気不明`（取得失敗とは扱わない）。 */
export const WEATHER_NAMES: Readonly<Record<WeatherCategory, string>> = {
  clear: "晴れ",
  cloudy: "くもり",
  fog: "霧",
  rain: "雨",
  snow: "雪",
  storm: "雷雨",
  unknown: "天気不明",
};

/** 気温・降水確率は整数で表示する。`-0`は`0`にする。 */
export const rounded = (value: number) => Math.round(value) + 0;

/**
 * 天気の各部分の表示状態（12.3）。
 * - `loading`：取得中（`data: null`かつ`lastAttemptAt: null`）
 * - `unavailable`：取得できない（Stateなし・初回取得の失敗・期限切れ）
 * - `noForecast`：有効だが、現在時刻から選べる枠・日が0。表示は`unavailable`と同じで、
 *   API取得失敗とは内部で区別する（20.5・22.5）
 * - `shown`：表示する。取得失敗＋有効なデータなら`stale`に最終更新時刻を持つ
 */
export type PartView<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "noForecast" }
  | { readonly kind: "shown"; readonly stale: Staleness; readonly value: T };

export const isShown = <T>(
  view: PartView<T>,
): view is Extract<PartView<T>, { kind: "shown" }> => view.kind === "shown";

type Valid<T> =
  | { readonly ok: false; readonly view: PartView<never> }
  | { readonly ok: true; readonly data: T; readonly stale: Staleness };

/** State共通の判定（12.3）。Domain部分は検証済み（published-state/schema.ts）。 */
function validState<T>(
  state: PublishedState | undefined,
  polling: PollingStatus,
  nowMs: number,
): Valid<T> {
  if (state === undefined)
    return {
      ok: false,
      view: { kind: polling === "waiting" ? "loading" : "unavailable" },
    };
  const { data, meta } = state;
  if (data === null)
    return {
      ok: false,
      view: { kind: meta.lastAttemptAt === null ? "loading" : "unavailable" },
    };
  if (meta.expiresAt === null || !(nowMs < Date.parse(meta.expiresAt)))
    return { ok: false, view: { kind: "unavailable" } };
  // `dataSource`は使わない（technology-stack 16.6・18.7）。
  const stale: Staleness =
    meta.lastAttemptResult === "failure" && meta.dataUpdatedAt !== null
      ? { since: staleSince(meta.dataUpdatedAt, nowMs) }
      : null;
  return { ok: true, data: data as T, stale };
}

export type CurrentWeather = {
  readonly temperature: number;
  readonly category: WeatherCategory;
  readonly night: boolean;
};

export type HourlySlot = {
  readonly validAt: string;
  /** `15時`。日付が変わる枠は`明日 0時`。 */
  readonly label: string;
  /** 日付が変わる枠（左にアクセント色の縦線を引く）。 */
  readonly dayStart: boolean;
  readonly category: WeatherCategory;
  /** 18:00〜翌05:59（UI設計 5.4、暫定採用）。 */
  readonly night: boolean;
  readonly temperature: number;
  readonly precipitation: number;
  readonly wet: boolean;
};

export type WeeklyDay = {
  readonly date: string;
  /** `今日`・`明日`・`水曜`。 */
  readonly label: string;
  /** `11/4`。 */
  readonly monthDay: string;
  readonly weekend: "sat" | "sun" | null;
  readonly today: boolean;
  readonly category: WeatherCategory;
  readonly max: number;
  readonly min: number;
  readonly precipitation: number;
  readonly wet: boolean;
  /** 気温バーの左端・右端の位置（%）。表示する日の最低〜最高に対する割合（UI設計 5.3）。 */
  readonly barLeft: number;
  readonly barRight: number;
};

/** JSTの時（0〜23）。 */
const tokyoHour = (ms: number) => new Date(ms + JST_OFFSET_MS).getUTCHours();
/** 次の正時。正時ちょうどはその時刻（20.5）。JSTの正時はUTCの正時と同じ。 */
const nextHour = (ms: number) => Math.ceil(ms / HOUR_MS) * HOUR_MS;
const dayStart = (date: string) => Date.parse(`${date}T00:00:00+09:00`);
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export function currentWeatherView(
  state: PublishedState | undefined,
  polling: PollingStatus,
  nowMs: number,
): PartView<CurrentWeather> {
  const valid = validState<CurrentWeatherData>(state, polling, nowMs);
  if (!valid.ok) return valid.view;
  // 鮮度（取得時の30分）は公開時に再適用しない（technology-stack 19.4）。
  const { data } = valid;
  return {
    kind: "shown",
    stale: valid.stale,
    value: {
      temperature: rounded(data.temperatureC),
      category: weatherCategory(data.weatherCode),
      night: !data.isDay,
    },
  };
}

/** 現在時刻の次の正時から、連続する最大12枠を選ぶ（20.5）。 */
export function hourlySlots(
  data: HourlyWeatherData,
  nowMs: number,
): HourlySlot[] {
  const start = nextHour(nowMs);
  const first = data.hours.findIndex((h) => Date.parse(h.validAt) === start);
  if (first < 0) return [];
  const today = tokyoDate(nowMs);
  return data.hours.slice(first, first + HOURLY_SLOTS).map((hour) => {
    const at = Date.parse(hour.validAt);
    const h = tokyoHour(at);
    const crossesDay = h === 0 && tokyoDate(at) !== today;
    return {
      validAt: hour.validAt,
      label: crossesDay ? "明日 0時" : `${h}時`,
      dayStart: crossesDay,
      category: weatherCategory(hour.weatherCode),
      night: h >= 18 || h < 6,
      temperature: rounded(hour.temperatureC),
      precipitation: rounded(hour.precipitationProbability),
      wet: hour.precipitationProbability >= WET_PERCENT,
    };
  });
}

export function hourlyWeatherView(
  state: PublishedState | undefined,
  polling: PollingStatus,
  nowMs: number,
): PartView<readonly HourlySlot[]> {
  const valid = validState<HourlyWeatherData>(state, polling, nowMs);
  if (!valid.ok) return valid.view;
  const slots = hourlySlots(valid.data, nowMs);
  if (slots.length === 0) return { kind: "noForecast" };
  return { kind: "shown", stale: valid.stale, value: slots };
}

/** 現在のJST暦日から、連続する最大7日を選ぶ（22.5）。 */
export function weeklyDays(
  data: WeeklyWeatherData,
  nowMs: number,
): WeeklyDay[] {
  const today = tokyoDate(nowMs);
  const first = data.days.findIndex((d) => d.date === today);
  if (first < 0) return [];
  const days = data.days.slice(first, first + WEEKLY_DAYS);
  const lo = Math.min(...days.map((d) => d.temperatureMinC));
  const hi = Math.max(...days.map((d) => d.temperatureMaxC));
  // 全日の最低と最高が同じなら、バーを全幅にする（0で割らない）。
  const position = (t: number) =>
    hi === lo ? 0 : ((t - lo) / (hi - lo)) * 100;
  return days.map((day, index) => {
    const weekday = new Date(dayStart(day.date) + JST_OFFSET_MS).getUTCDay();
    const name = WEEKDAYS[weekday]!;
    return {
      date: day.date,
      label: index === 0 ? "今日" : index === 1 ? "明日" : `${name}曜`,
      monthDay: `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8, 10))}`,
      weekend: weekday === 6 ? "sat" : weekday === 0 ? "sun" : null,
      today: index === 0,
      category: weatherCategory(day.weatherCode),
      max: rounded(day.temperatureMaxC),
      min: rounded(day.temperatureMinC),
      precipitation: rounded(day.precipitationProbability),
      wet: day.precipitationProbability >= WET_PERCENT,
      barLeft: position(day.temperatureMinC),
      barRight: hi === lo ? 0 : 100 - position(day.temperatureMaxC),
    };
  });
}

export function weeklyWeatherView(
  state: PublishedState | undefined,
  polling: PollingStatus,
  nowMs: number,
): PartView<readonly WeeklyDay[]> {
  const valid = validState<WeeklyWeatherData>(state, polling, nowMs);
  if (!valid.ok) return valid.view;
  const days = weeklyDays(valid.data, nowMs);
  if (days.length === 0) return { kind: "noForecast" };
  return { kind: "shown", stale: valid.stale, value: days };
}

/** 降雨の表示鮮度とTTL（technology-stack 21.6）。基準は`dataUpdatedAt`。 */
export const RAIN_FRESH_MS = 10 * 60_000;
export const RAIN_TTL_MS = 30 * 60_000;
const FIVE_MIN_MS = 5 * 60_000;
const INTENSITY_NAMES = {
  light: "弱い雨",
  moderate: "普通の雨",
  heavy: "強い雨",
} as const;

/**
 * 降雨帯の予報部分（UI設計 5.2）。`status`は再計算しない（21.6）。
 * - `none`：1時間以内の雨の予報はない
 * - `rain`：`text`に文言、降り始めの前なら`remaining`に`あと約20分`・`まもなく`
 * - `passed`：降り始め・降り終わりの予報時刻を過ぎた。降雨状態は推測しない
 */
export type RainBand =
  | { readonly kind: "none" }
  | {
      readonly kind: "rain";
      readonly text: string;
      readonly remaining: string | null;
    }
  | { readonly kind: "passed" };

/**
 * 降雨帯の表示状態（technology-stack 21.6、UI設計 5.2・6.1）：
 * - `loading`・`unavailable`：取得中・取得できない（30分以上、期限切れ、未来の`dataUpdatedAt`を含む）
 * - `waiting`：取得から10分以上30分未満。予報は隠し、`since`に最終更新時刻
 * - `shown`：取得から10分未満。直近の取得が失敗なら`stale`に最終更新時刻
 */
export type RainView =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "waiting"; readonly since: string }
  | {
      readonly kind: "shown";
      readonly stale: Staleness;
      readonly band: RainBand;
    };

/** 5分単位に丸めたJSTの時刻。 */
const roundedTime = (ms: number) =>
  tokyoTime(Math.round(ms / FIVE_MIN_MS) * FIVE_MIN_MS);

/** 予報の文言と、「あと約N分」（降り始めの前だけ）。時刻を過ぎていれば`passed`。 */
export function rainBand(data: RainForecastData, nowMs: number): RainBand {
  if (data.intensity === null) return { kind: "none" };
  const name = INTENSITY_NAMES[data.intensity];
  if (data.status === "raining") {
    if (data.rainEndAt === null)
      return {
        kind: "rain",
        text: `${name}　しばらく続く見込み`,
        remaining: null,
      };
    const end = Date.parse(data.rainEndAt);
    if (!(nowMs < end)) return { kind: "passed" };
    return {
      kind: "rain",
      text: `${name}　${roundedTime(end)}ごろやむ見込み`,
      remaining: null,
    };
  }
  // 雨が見込まれるが今は降っていない：降り始めは後（形は検証済み）。
  const start = Date.parse(data.rainStartAt!);
  if (!(nowMs < start)) return { kind: "passed" };
  const minutes = (start - nowMs) / 60_000;
  return {
    kind: "rain",
    text: `${roundedTime(start)}ごろから${name}`,
    remaining:
      minutes < 5 ? "まもなく" : `あと約${Math.round(minutes / 5) * 5}分`,
  };
}

export function rainForecastView(
  state: PublishedState | undefined,
  polling: PollingStatus,
  nowMs: number,
): RainView {
  const valid = validState<RainForecastData>(state, polling, nowMs);
  if (!valid.ok)
    return valid.view.kind === "loading"
      ? { kind: "loading" }
      : { kind: "unavailable" };
  // validStateを通ったのでdataUpdatedAtはある（10.6）。
  const updated = state!.meta.dataUpdatedAt!;
  const age = nowMs - Date.parse(updated);
  if (!(age >= 0) || age >= RAIN_TTL_MS) return { kind: "unavailable" };
  if (age >= RAIN_FRESH_MS)
    return { kind: "waiting", since: staleSince(updated, nowMs) };
  const band = rainBand(valid.data, nowMs);
  // 予報時刻を過ぎたら、更新待ちの札を付ける（降雨状態は推測しない）。
  const stale: Staleness =
    valid.stale ??
    (band.kind === "passed" ? { since: staleSince(updated, nowMs) } : null);
  return { kind: "shown", stale, band };
}

/** 巡回の「表示できる」に数えるか。更新待ち・予報時刻超過は数えない（UI設計 6.2）。 */
export const isRainDisplayable = (view: RainView): boolean =>
  view.kind === "shown" && view.band.kind !== "passed";

/** 今日の天気（UI設計 5.2）。最高・最低は週間天気の今日が表示できるときだけ持つ。 */
export type TodayWeatherView = {
  readonly current: PartView<CurrentWeather>;
  readonly hourly: PartView<readonly HourlySlot[]>;
  readonly rain: RainView;
  readonly highLow: { readonly max: number; readonly min: number } | null;
};

export function todayWeatherView(
  current: PartView<CurrentWeather>,
  hourly: PartView<readonly HourlySlot[]>,
  weekly: PartView<readonly WeeklyDay[]>,
  rain: RainView = { kind: "unavailable" },
): TodayWeatherView {
  // 週間天気の選択は今日から始まるので、表示できるなら先頭が今日。
  const today = isShown(weekly) ? weekly.value[0] : undefined;
  return {
    current,
    hourly,
    rain,
    highLow: today?.today ? { max: today.max, min: today.min } : null,
  };
}

/**
 * 巡回に残すか（UI設計 6.2、frontend-development 12.5）。今日の天気は、現在の天気・時間別・
 * 降雨のどれか1つでも表示できれば残す。降雨は予報を表示できるときだけ数える。
 */
export function isTodayWeatherDisplayable(view: TodayWeatherView): boolean {
  return (
    isShown(view.current) ||
    isShown(view.hourly) ||
    isRainDisplayable(view.rain)
  );
}

export function isWeeklyWeatherDisplayable(
  view: PartView<readonly WeeklyDay[]>,
): boolean {
  return isShown(view);
}
