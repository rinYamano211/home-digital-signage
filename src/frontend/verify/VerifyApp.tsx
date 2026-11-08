import { useEffect, useState } from "react";
import type { TimeAvailability } from "../clock/availability";
import { CONTENTS } from "../content/registry";
import { useMinuteNow } from "../published-state/usePublishedStates";
import { signageModel } from "../signage-model";
import { SignageScreen } from "../SignageScreen";
import {
  POLLING_STATUSES,
  SCHEDULE_SCENARIOS,
  scenarioSnapshot,
} from "./schedule-scenarios";
import { WEATHER_SCENARIOS, weatherScenario } from "./weather-scenarios";

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

// 数字キー1・2・3で、各コンテンツを巡回から外す（docs/frontend-development.md 10.7）。
const DIGIT_KEYS = ["Digit1", "Digit2", "Digit3"] as const;
const next = (index: number, length: number) => (index + 1) % length;

/**
 * 検証画面。合成データで表示を切り替える（表示用APIには接続しない）。
 * - Spaceキー：時刻の`available` / `unavailable`
 * - 1・2・3キー：今日の予定・今日の天気・週間天気を巡回から外す／戻す
 * - Sキー：予定の合成データ（docs/frontend-development.md 11.7）
 * - Pキー：Pollingの状態（正常取得・最初の応答待ち・一度も取得できない）
 * - Wキー：天気の合成データ（docs/frontend-development.md 12.7）
 * Raspberry PiのKiosk表示では、USBキーボードで切り替えられる。
 */
export function VerifyApp() {
  const [availability, setAvailability] =
    useState<TimeAvailability>("unavailable");
  const [enabled, setEnabled] = useState<ReadonlySet<string>>(
    () => new Set(CONTENTS.map((content) => content.id)),
  );
  const [scenario, setScenario] = useState(0);
  const [polling, setPolling] = useState(0);
  const [weather, setWeather] = useState(0);
  const now = useMinuteNow();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        event.preventDefault();
        setAvailability(toggle);
        return;
      }
      if (event.code === "KeyS") {
        event.preventDefault();
        setScenario((i) => next(i, SCHEDULE_SCENARIOS.length));
        return;
      }
      if (event.code === "KeyW") {
        event.preventDefault();
        setWeather((i) => next(i, WEATHER_SCENARIOS.length));
        return;
      }
      if (event.code === "KeyP") {
        event.preventDefault();
        setPolling((i) => next(i, POLLING_STATUSES.length));
        return;
      }
      const index = DIGIT_KEYS.findIndex((code) => code === event.code);
      const content = CONTENTS[index];
      if (content !== undefined) {
        event.preventDefault();
        setEnabled((current) => toggleId(current, content.id));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const status = POLLING_STATUSES[polling] ?? "received";
  // 天気のシナリオによっては、表示の評価に使う時刻を今日の決まった時刻にする（weather-scenarios.ts）。
  const sky = weatherScenario(weather, now);
  const base = scenarioSnapshot(scenario, status, sky.at);
  const snapshot =
    status === "received"
      ? { ...base, states: { ...base.states, ...sky.states } }
      : base;
  const model = signageModel(snapshot, sky.at);
  const displayable = new Set(
    [...model.displayable].filter((id) => enabled.has(id)),
  );

  return (
    <>
      <SignageScreen
        time={availability}
        displayable={displayable}
        notice={model.notice}
        context={model}
      />
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
            aria-pressed={enabled.has(content.id)}
            onClick={() =>
              setEnabled((current) => toggleId(current, content.id))
            }
          >
            {index + 1}：{content.label}
            {enabled.has(content.id) ? "（巡回）" : "（外す）"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setScenario((i) => next(i, SCHEDULE_SCENARIOS.length))}
        >
          S：予定「{SCHEDULE_SCENARIOS[scenario]?.label}」
        </button>
        <button
          type="button"
          onClick={() => setPolling((i) => next(i, POLLING_STATUSES.length))}
        >
          P：Polling「{status}」
        </button>
        <button
          type="button"
          onClick={() => setWeather((i) => next(i, WEATHER_SCENARIOS.length))}
        >
          W：天気「{WEATHER_SCENARIOS[weather]?.label}」
        </button>
      </div>
    </>
  );
}
