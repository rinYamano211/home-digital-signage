// 表示用APIの状態から、巡回の入力（表示できるコンテンツ・0件のときの1枚表示）を導く
// （docs/frontend-development.md 11.6・12.5）。Reactに依存しない純粋関数。
import type { PollingSnapshot } from "./published-state/polling";
import type { StateKey } from "./published-state/schema";
import {
  isScheduleDisplayable,
  scheduleView,
  type ScheduleView,
} from "./schedule/schedule-state";
import {
  currentWeatherView,
  hourlyWeatherView,
  isTodayWeatherDisplayable,
  isWeeklyWeatherDisplayable,
  todayWeatherView,
  weeklyWeatherView,
  type PartView,
  type TodayWeatherView,
  type WeeklyDay,
} from "./weather/weather-state";

/** 表示できるコンテンツが0件のときの1枚表示の種類。 */
export type NoContentNotice = "loading" | "unavailable";

export type SignageModel = {
  readonly schedule: ScheduleView;
  readonly todayWeather: TodayWeatherView;
  readonly weeklyWeather: PartView<readonly WeeklyDay[]>;
  /** 現在表示できるコンテンツのid（ContentSwitcherへ渡す。10.5）。 */
  readonly displayable: ReadonlySet<string>;
  readonly notice: NoContentNotice;
};

/**
 * 本番で未実装と明示したState（frontend-development 12.5、UI設計 6.5）。取得中の1枚表示の判定で
 * 数えない。実装済みのStateの取得失敗・省略は除外しない。#93でRainForecastを本番に登録するときに
 * この一覧から外す。
 */
export const UNIMPLEMENTED_STATES: ReadonlySet<StateKey> = new Set([
  "rainForecast",
]);

/**
 * 優先順（時刻が`unavailable`の1枚表示は、巡回側が最優先で扱う）：
 * 1. 最初の応答を待っている → `予定と天気を取得しています`
 * 2. 一度も正常取得できないまま最初のPollingが失敗 → `予定と天気を取得できません`
 * 3. 表示できるコンテンツが0件 → 理由がすべて「取得中」なら取得中、それ以外は取得できません
 * 4. それ以外 → 表示できるコンテンツを巡回する
 */
export function signageModel(
  snapshot: PollingSnapshot,
  nowMs: number,
): SignageModel {
  const { states, status } = snapshot;
  const schedule = scheduleView(states.schedule, status, nowMs);
  const current = currentWeatherView(states.currentWeather, status, nowMs);
  const hourly = hourlyWeatherView(states.hourlyWeather, status, nowMs);
  const weeklyWeather = weeklyWeatherView(states.weeklyWeather, status, nowMs);
  const todayWeather = todayWeatherView(current, hourly, weeklyWeather);
  const views = { schedule, todayWeather, weeklyWeather };
  if (status === "waiting")
    return { ...views, displayable: new Set(), notice: "loading" };
  if (status === "neverReceived")
    return { ...views, displayable: new Set(), notice: "unavailable" };
  const displayable = new Set<string>();
  if (isScheduleDisplayable(schedule)) displayable.add("schedule");
  if (isTodayWeatherDisplayable(todayWeather)) displayable.add("todayWeather");
  if (isWeeklyWeatherDisplayable(weeklyWeather))
    displayable.add("weeklyWeather");
  // 各Stateが表示できない理由。降雨帯は#93が終わるまで常に表示できない（12.3）。
  const reasons: readonly (readonly [StateKey, string])[] = [
    ["schedule", schedule.kind],
    ["currentWeather", current.kind],
    ["hourlyWeather", hourly.kind],
    ["rainForecast", "unavailable"],
    ["weeklyWeather", weeklyWeather.kind],
  ];
  // 0件で、表示できない理由がすべて「取得中」のときだけ取得中の1枚表示にする。
  const allLoading =
    displayable.size === 0 &&
    reasons
      .filter(([key]) => !UNIMPLEMENTED_STATES.has(key))
      .every(([, kind]) => kind === "loading");
  return {
    ...views,
    displayable,
    notice: allLoading ? "loading" : "unavailable",
  };
}
