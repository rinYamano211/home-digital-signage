import { useEffect, useState } from "react";
import type { TimeAvailability } from "../clock/availability";
import { CONTENTS } from "../content/registry";
import { SignageScreen } from "../SignageScreen";

function toggle(value: TimeAvailability): TimeAvailability {
  return value === "available" ? "unavailable" : "available";
}

function toggleId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

// 数字キー1・2・3で、各コンテンツの表示可否を切り替える（docs/frontend-development.md 10.7）。
const DIGIT_KEYS = ["Digit1", "Digit2", "Digit3"] as const;

/**
 * 検証画面。時刻の利用可否と、各コンテンツの表示可否を手動で切り替える。
 * - Spaceキー：時刻の`available` / `unavailable`
 * - 1・2・3キー：今日の予定・今日の天気・週間天気の表示可否
 * Raspberry PiのKiosk表示では、USBキーボードで切り替えられる。
 */
export function VerifyApp() {
  const [availability, setAvailability] =
    useState<TimeAvailability>("unavailable");
  const [displayable, setDisplayable] = useState<ReadonlySet<string>>(
    () => new Set(CONTENTS.map((content) => content.id)),
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setAvailability(toggle);
        return;
      }
      const index = DIGIT_KEYS.findIndex((code) => code === event.code);
      const content = CONTENTS[index];
      if (content !== undefined) {
        event.preventDefault();
        setDisplayable((current) => toggleId(current, content.id));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <SignageScreen time={availability} displayable={displayable} />
      <div className="verify-panel" data-verify-panel>
        <span>検証画面：{availability}</span>
        <button type="button" onClick={() => setAvailability("available")}>
          available
        </button>
        <button type="button" onClick={() => setAvailability("unavailable")}>
          unavailable
        </button>
        <span>Spaceキーで切替</span>
        {CONTENTS.map((content, index) => (
          <button
            key={content.id}
            type="button"
            aria-pressed={displayable.has(content.id)}
            onClick={() =>
              setDisplayable((current) => toggleId(current, content.id))
            }
          >
            {index + 1}：{content.label}
            {displayable.has(content.id) ? "（表示可）" : "（表示不可）"}
          </button>
        ))}
      </div>
    </>
  );
}
