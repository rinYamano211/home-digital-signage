import { useState } from "react";
import { ClockPauseIcon } from "../icons/ClockPauseIcon";
import {
  clockFaceKind,
  shouldFadeInClock,
  type TimeAvailability,
} from "./availability";
import { useClockText } from "./useClockText";

type Props = {
  /** 時刻の利用可否。判定は外部が行い、時計タイルは受け取るだけ（D6）。 */
  readonly availability: TimeAvailability;
};

/** 左45%の時計タイル。通常画面と検証画面で同じものを使う（D13）。 */
export function ClockTile({ availability }: Props) {
  // 前回の利用可否を覚えておき、未同期から復帰したときだけフェードする。
  const [previous, setPrevious] = useState(availability);
  const [fadeIn, setFadeIn] = useState(false);
  if (previous !== availability) {
    setPrevious(availability);
    setFadeIn(shouldFadeInClock(previous, availability));
  }

  return (
    <section className="tile clock-tile" aria-label="時計">
      {clockFaceKind(availability) === "clock" ? (
        <ClockFace fadeIn={fadeIn} />
      ) : (
        <UnavailableFace />
      )}
    </section>
  );
}

function ClockFace({ fadeIn }: { readonly fadeIn: boolean }) {
  // 時刻の確認は、日付と時刻を表示している間だけ行う。
  const { date, time } = useClockText();
  return (
    <div className={fadeIn ? "clock-face clock-fade-in" : "clock-face"}>
      <div className="clock-date">{date}</div>
      <div className="clock-time">{time}</div>
    </div>
  );
}

function UnavailableFace() {
  return (
    <div className="clock-unavailable">
      <ClockPauseIcon className="clock-unavailable-icon" />
      <div className="clock-unavailable-title">時刻を合わせています</div>
      <div className="clock-unavailable-note">
        ネットにつながると自動で表示します
      </div>
    </div>
  );
}
