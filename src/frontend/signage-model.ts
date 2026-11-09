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
  rainForecastView,
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
 * 取得中の1枚表示の判定（表示できるコンテンツが0件のとき）で数えないState（UI設計 6.5、
 * frontend-development 12.5。MVPの正式仕様）。RainForecastは、Tomorrow.ioの利用開始条件
 * （APIキー・Quota Provisioning・Clock Trust）が整うまで省略されたままになりうるため、
 * 本番に登録した後も恒久的に数えない。降雨帯は個別に表示する。他のStateの取得失敗・省略は
 * 除外しない。
 */
export const EXCLUDED_FROM_LOADING_JUDGEMENT: ReadonlySet<StateKey> = new Set([
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
  const rain = rainForecastView(states.rainForecast, status, nowMs);
  const todayWeather = todayWeatherView(current, hourly, weeklyWeather, rain);
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
  // 各Stateが表示できない理由。降雨帯は個別に表示するため、ここでは数えない。
  const reasons: readonly (readonly [StateKey, string])[] = [
    ["schedule", schedule.kind],
    ["currentWeather", current.kind],
    ["hourlyWeather", hourly.kind],
    ["rainForecast", rain.kind],
    ["weeklyWeather", weeklyWeather.kind],
  ];
  // 0件で、表示できない理由がすべて「取得中」のときだけ取得中の1枚表示にする。
  const allLoading =
    displayable.size === 0 &&
    reasons
      .filter(([key]) => !EXCLUDED_FROM_LOADING_JUDGEMENT.has(key))
      .every(([, kind]) => kind === "loading");
  return {
    ...views,
    displayable,
    notice: allLoading ? "loading" : "unavailable",
  };
}
