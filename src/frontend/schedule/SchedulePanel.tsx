import { fitSchedule } from "./fit";
import type { ScheduleView, TimedRow } from "./schedule-state";

/** 予定の1行。タイトルはReactの通常のテキストとして描画する（HTMLとして解釈しない）。 */
function Row({ row, className }: { row: TimedRow; className?: string }) {
  return (
    <div className={`schedule-row ${className ?? ""}`}>
      <span className="schedule-time">{row.time}</span>
      <span className="schedule-title">
        {row.title}
        {row.until}
      </span>
    </div>
  );
}

function Big({ row, label }: { row: TimedRow; label: "進行中" | "次の予定" }) {
  return (
    <div className={`schedule-big ${label === "次の予定" ? "is-next" : ""}`}>
      <div className="schedule-big-label">{label}</div>
      <Row row={row} />
    </div>
  );
}

/** 取得失敗＋有効なデータのときの札（UI設計 6.1）。 */
function StaleBadge({ since }: { since: string }) {
  return <div className="stale-badge">↻ 更新待ち・{since}時点</div>;
}

type Props = { readonly view: ScheduleView };

/** 今日の予定（UI設計 5.1）。巡回に残るのは`list`・`empty`だけ（6.2）。 */
export function SchedulePanel({ view }: Props) {
  if (view.kind === "loading" || view.kind === "unavailable") {
    // 巡回からは外れる。切替の途中で状態が変わったときだけ描画される。
    return (
      <div className="tile schedule-panel schedule-message">
        {view.kind === "loading"
          ? "予定を取得しています"
          : "予定を取得できません"}
      </div>
    );
  }
  const stale = view.stale;
  const className = `tile schedule-panel ${stale ? "has-badge" : ""}`;
  if (view.kind === "empty")
    return (
      <div className={`${className} schedule-message`}>
        {stale && <StaleBadge since={stale.since} />}
        本日の予定はありません
      </div>
    );
  const fitted = fitSchedule(view.list, stale !== null);
  return (
    <div className={className}>
      {stale && <StaleBadge since={stale.since} />}
      {fitted.allDay.length > 0 && (
        <div className="schedule-chips">
          {fitted.allDay.map((chip) => (
            <span key={chip.id} className="schedule-chip">
              {"終日　"}
              {chip.title}
              {chip.until}
            </span>
          ))}
        </div>
      )}
      {fitted.ended.map((row) => (
        <Row key={row.id} row={row} className="is-ended" />
      ))}
      {fitted.endedSummary !== null && (
        <div className="schedule-summary">{fitted.endedSummary}</div>
      )}
      {fitted.ongoing.map((row) => (
        <Big key={row.id} row={row} label="進行中" />
      ))}
      {fitted.next && <Big row={fitted.next} label="次の予定" />}
      {fitted.later.map((row) => (
        <Row key={row.id} row={row} />
      ))}
      {fitted.hidden > 0 && (
        <div className="schedule-more">ほか {fitted.hidden}件</div>
      )}
    </div>
  );
}
