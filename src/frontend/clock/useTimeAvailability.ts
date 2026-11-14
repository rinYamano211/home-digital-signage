import { useEffect, useState } from "react";
import type { TimeAvailability } from "./availability";
import { startTimeAvailability } from "./time-availability-polling";

export type TimeAvailabilityView = {
  readonly availability: TimeAvailability;
  /** 値が変わった時刻（ms、System Time）。予定・天気の評価をその時点の時刻でやり直すために使う（13.4）。 */
  readonly changedAt: number;
};

/**
 * 表示用時刻の利用可否をReactにつなぐ（docs/frontend-development.md 第13章）。
 * `App`の直下で1回だけ使う。最初は`unavailable`。Unmount時にRequestとTimerを止める。
 */
export function useTimeAvailability(): TimeAvailabilityView {
  const [view, setView] = useState<TimeAvailabilityView>({
    availability: "unavailable",
    changedAt: 0,
  });
  useEffect(
    () =>
      startTimeAvailability((availability) =>
        setView({ availability, changedAt: Date.now() }),
      ),
    [],
  );
  return view;
}
