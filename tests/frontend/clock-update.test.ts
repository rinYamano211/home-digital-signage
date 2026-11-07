import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatClock,
  nextClockText,
  type ClockText,
} from "../../src/frontend/clock/format";
import { CLOCK_TICK_MS } from "../../src/frontend/clock/useClockText";

// useClockTextが使う更新規則（nextClockText）を、同じ間隔のTimerとFake Timerで動かして確かめる。
// Reactの描画そのものはBrowserで目視確認する（docs/frontend-development.md 4章 D5）。
function startClock(onUpdate: (text: ClockText) => void): () => void {
  let current = formatClock(Date.now());
  const id = setInterval(() => {
    const next = nextClockText(current, Date.now());
    if (next !== current) {
      current = next;
      onUpdate(next);
    }
  }, CLOCK_TICK_MS);
  return () => clearInterval(id);
}

describe("clock update rule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks the time every second", () => {
    expect(CLOCK_TICK_MS).toBe(1000);
  });

  it("updates once per minute, not on every tick", () => {
    vi.setSystemTime(new Date("2026-11-02T05:30:00Z"));
    const updates: ClockText[] = [];
    const stop = startClock((text) => updates.push(text));

    vi.advanceTimersByTime(59_000);
    expect(updates).toEqual([]);

    vi.advanceTimersByTime(1_000);
    expect(updates).toEqual([{ date: "11月2日（月）", time: "14:31" }]);

    vi.advanceTimersByTime(60_000);
    expect(updates.map((t) => t.time)).toEqual(["14:31", "14:32"]);
    stop();
  });

  it("follows the date change at midnight JST within one second", () => {
    vi.setSystemTime(new Date("2026-11-02T14:59:59.500Z"));
    const updates: ClockText[] = [];
    const stop = startClock((text) => updates.push(text));

    vi.advanceTimersByTime(1_000);
    expect(updates).toEqual([{ date: "11月3日（火）", time: "00:00" }]);
    stop();
  });

  it("follows a system time correction (jump back or forward) within one second", () => {
    vi.setSystemTime(new Date("2026-11-02T05:30:00Z"));
    const updates: ClockText[] = [];
    const stop = startClock((text) => updates.push(text));

    // 時刻同期などでSystem Timeが大きく戻った場合
    vi.setSystemTime(new Date("2026-11-01T22:00:00Z"));
    vi.advanceTimersByTime(1_000);
    expect(updates.at(-1)).toEqual({ date: "11月2日（月）", time: "07:00" });

    // 大きく進んだ場合
    vi.setSystemTime(new Date("2026-11-05T03:15:00Z"));
    vi.advanceTimersByTime(1_000);
    expect(updates.at(-1)).toEqual({ date: "11月5日（木）", time: "12:15" });
    stop();
  });
});
