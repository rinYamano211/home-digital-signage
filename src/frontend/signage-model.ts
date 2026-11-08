// 表示用APIの状態から、巡回の入力（表示できるコンテンツ・0件のときの1枚表示）を導く
// （docs/frontend-development.md 11.6）。Reactに依存しない純粋関数。
import type { PollingSnapshot } from "./published-state/polling";
import {
  isScheduleDisplayable,
  scheduleView,
  type ScheduleView,
} from "./schedule/schedule-state";

/** 表示できるコンテンツが0件のときの1枚表示の種類。 */
export type NoContentNotice = "loading" | "unavailable";

export type SignageModel = {
  readonly schedule: ScheduleView;
  /** 現在表示できるコンテンツのid（ContentSwitcherへ渡す。10.5）。 */
  readonly displayable: ReadonlySet<string>;
  readonly notice: NoContentNotice;
};

/** #9が入るまで、天気は仮パネルのまま「表示できる」として扱う（10.7）。 */
const WEATHER_PLACEHOLDERS = ["todayWeather", "weeklyWeather"] as const;

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
  const schedule = scheduleView(
    snapshot.states.schedule,
    snapshot.status,
    nowMs,
  );
  if (snapshot.status === "waiting")
    return { schedule, displayable: new Set(), notice: "loading" };
  if (snapshot.status === "neverReceived")
    return { schedule, displayable: new Set(), notice: "unavailable" };
  const displayable = new Set<string>(WEATHER_PLACEHOLDERS);
  if (isScheduleDisplayable(schedule)) displayable.add("schedule");
  // 0件で、表示できない理由がすべて「取得中」のときだけ取得中の1枚表示にする。
  const allLoading = displayable.size === 0 && schedule.kind === "loading";
  return {
    schedule,
    displayable,
    notice: allLoading ? "loading" : "unavailable",
  };
}
