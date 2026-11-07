import { useEffect, useState } from "react";
import type { TimeAvailability } from "../clock/availability";
import { ClockTile } from "../clock/ClockTile";
import { Screen } from "../layout/Screen";

function toggle(value: TimeAvailability): TimeAvailability {
  return value === "available" ? "unavailable" : "available";
}

/**
 * 検証画面。ボタン、またはキーボードのSpaceキーで利用可否を切り替える。
 * Raspberry PiのKiosk表示では、USBキーボードのSpaceキーで切り替えられる。
 */
export function VerifyApp() {
  const [availability, setAvailability] =
    useState<TimeAvailability>("unavailable");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setAvailability(toggle);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <Screen clock={<ClockTile availability={availability} />} />
      <div className="verify-panel" data-verify-panel>
        <span>検証画面：{availability}</span>
        <button type="button" onClick={() => setAvailability("available")}>
          available
        </button>
        <button type="button" onClick={() => setAvailability("unavailable")}>
          unavailable
        </button>
        <span>Spaceキーで切替</span>
      </div>
    </>
  );
}
