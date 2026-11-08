import { ClockPauseIcon } from "../icons/ClockPauseIcon";
import { HourglassIcon } from "../icons/HourglassIcon";
import { WifiOffIcon } from "../icons/WifiOffIcon";

/** 時刻未同期中の1枚表示（UI設計 6.3）。巡回を止めている間に表示する。 */
export function TimeUnavailableCard() {
  return (
    <div className="tile notice-card">
      <ClockPauseIcon className="notice-icon" />
      <div className="notice-title">時刻を確認できるまで</div>
      <div className="notice-title">予定と天気は表示しません</div>
    </div>
  );
}

/** 表示できるコンテンツが0件のときの1枚表示（UI設計 6.2）。時計は通常どおり表示する。 */
export function NoContentCard() {
  return (
    <div className="tile notice-card">
      <WifiOffIcon className="notice-icon" />
      <div className="notice-title">予定と天気を取得できません</div>
      <div className="notice-note">自動で再試行しています</div>
    </div>
  );
}

/** 起動直後・取得中の1枚表示（UI設計 6.5、docs/frontend-development.md 11.6）。 */
export function LoadingCard() {
  return (
    <div className="tile notice-card">
      <HourglassIcon className="notice-icon" />
      <div className="notice-title">予定と天気を取得しています</div>
    </div>
  );
}
