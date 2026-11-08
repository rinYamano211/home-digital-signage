// 予定一覧が予定パネルに収まるかの計算（UI設計 5.1、docs/frontend-development.md 11.5）。
// DOMの計測は使わず、行の高さの目安から計算する。値は実機で調整する（layout-config.ts）。
import { SCHEDULE_LAYOUT as L } from "./layout-config";
import type { ScheduleList, TimedRow } from "./schedule-state";

export type FittedSchedule = {
  readonly allDay: ScheduleList["allDay"];
  /** 個別に表示する終了済み。集約したときは空。 */
  readonly ended: readonly TimedRow[];
  /** 終了済みを1行にまとめたとき：`終了済み 6件（07:00 ゴミ出し ほか）`。 */
  readonly endedSummary: string | null;
  readonly ongoing: readonly TimedRow[];
  readonly next: TimedRow | null;
  readonly later: readonly TimedRow[];
  /** 末尾から省いた件数（`ほか N件`）。 */
  readonly hidden: number;
};

function height(
  list: ScheduleList,
  endedRows: number,
  summary: boolean,
  later: number,
  hidden: number,
  stale: boolean,
): number {
  const chipRows = Math.ceil(list.allDay.length / L.chipsPerRow);
  const big = list.ongoing.length + (list.next ? 1 : 0);
  return (
    (stale ? L.staleBadgeExtra : 0) +
    (chipRows > 0 ? chipRows * L.chipRow + L.chipsMargin : 0) +
    endedRows * L.endedRow +
    (summary ? L.summaryRow : 0) +
    big * L.bigBlock +
    later * L.row +
    (hidden > 0 ? L.moreRow : 0)
  );
}

/**
 * 収まる場合は全件を表示する。収まらない場合に限り、終了済みを件数付きの1行に集約し、
 * なお収まらなければ遅い予定から`ほか N件`として省く。進行中と次の予定は省かない。
 */
export function fitSchedule(
  list: ScheduleList,
  stale: boolean,
): FittedSchedule {
  const limit = L.panelHeight;
  const full = (summary: boolean, later: number, hidden: number) =>
    height(
      list,
      summary ? 0 : list.ended.length,
      summary,
      later,
      hidden,
      stale,
    );
  if (full(false, list.later.length, 0) <= limit)
    return { ...list, endedSummary: null, hidden: 0 };
  const summary = list.ended.length > 0;
  let shown = list.later.length;
  while (shown > 0 && full(summary, shown, list.later.length - shown) > limit)
    shown--;
  const first = list.ended[0];
  return {
    allDay: list.allDay,
    ended: summary ? [] : list.ended,
    endedSummary:
      summary && first
        ? `終了済み ${list.ended.length}件（${first.time} ${first.title}${list.ended.length > 1 ? " ほか" : ""}）`
        : null,
    ongoing: list.ongoing,
    next: list.next,
    later: list.later.slice(0, shown),
    hidden: list.later.length - shown,
  };
}
