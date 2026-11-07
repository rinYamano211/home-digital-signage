import { describe, expect, it } from "vitest";
import {
  formatClock,
  isSameClockText,
  nextClockText,
} from "../../src/frontend/clock/format";

// 期待値はJST（UTC+9、夏時間なし）。入力はUTCで書き、OSのTimezoneに依存しないことを確かめる。
const utc = (iso: string) => Date.parse(iso);

describe("formatClock", () => {
  it("formats date and time in the UI design style", () => {
    expect(formatClock(utc("2026-11-02T05:30:00Z"))).toEqual({
      date: "11月2日（月）",
      time: "14:30",
    });
  });

  it("uses Asia/Tokyo regardless of the UTC date", () => {
    // UTCでは11月1日（日）15:00だが、JSTでは11月2日（月）0:00
    expect(formatClock(utc("2026-11-01T15:00:00Z"))).toEqual({
      date: "11月2日（月）",
      time: "00:00",
    });
    // UTCでは11月2日（月）14:59だが、JSTでは11月2日（月）23:59
    expect(formatClock(utc("2026-11-02T14:59:00Z"))).toEqual({
      date: "11月2日（月）",
      time: "23:59",
    });
  });

  it("uses a 24-hour clock with a zero-padded hour and no seconds", () => {
    expect(formatClock(utc("2026-11-02T00:05:59Z")).time).toBe("09:05");
    expect(formatClock(utc("2026-11-02T13:45:30Z")).time).toBe("22:45");
  });

  it("does not pad month or day and shows the weekday in full-width parentheses", () => {
    expect(formatClock(utc("2027-01-01T03:00:00Z")).date).toBe("1月1日（金）");
    expect(formatClock(utc("2026-12-31T03:00:00Z")).date).toBe(
      "12月31日（木）",
    );
  });

  it("handles month ends and leap days", () => {
    expect(formatClock(utc("2028-02-29T03:00:00Z")).date).toBe("2月29日（火）");
    // JSTで2月28日 23:59 → 3月1日 0:00（2027年は平年）
    expect(formatClock(utc("2027-02-28T14:59:00Z"))).toEqual({
      date: "2月28日（日）",
      time: "23:59",
    });
    expect(formatClock(utc("2027-02-28T15:00:00Z"))).toEqual({
      date: "3月1日（月）",
      time: "00:00",
    });
  });

  it("covers every weekday", () => {
    const weekdays = ["月", "火", "水", "木", "金", "土", "日"];
    weekdays.forEach((weekday, offset) => {
      const epochMs = utc("2026-11-02T03:00:00Z") + offset * 86_400_000;
      expect(formatClock(epochMs).date).toBe(
        `11月${2 + offset}日（${weekday}）`,
      );
    });
  });
});

describe("isSameClockText", () => {
  it("is true only when both date and time are equal", () => {
    const base = formatClock(utc("2026-11-02T05:30:00Z"));
    expect(
      isSameClockText(base, formatClock(utc("2026-11-02T05:30:59Z"))),
    ).toBe(true);
    expect(
      isSameClockText(base, formatClock(utc("2026-11-02T05:31:00Z"))),
    ).toBe(false);
    expect(
      isSameClockText(base, { date: "11月3日（火）", time: "14:30" }),
    ).toBe(false);
  });
});

describe("nextClockText", () => {
  it("keeps the same object while the displayed text is unchanged", () => {
    const current = formatClock(utc("2026-11-02T05:30:00Z"));
    expect(nextClockText(current, utc("2026-11-02T05:30:59Z"))).toBe(current);
  });

  it("returns the new text when the minute changes", () => {
    const current = formatClock(utc("2026-11-02T05:30:59Z"));
    expect(nextClockText(current, utc("2026-11-02T05:31:00Z"))).toEqual({
      date: "11月2日（月）",
      time: "14:31",
    });
  });
});
