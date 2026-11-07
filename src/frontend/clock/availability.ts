// 時刻の利用可否は、時計タイルの外から状態として受け取る（docs/frontend-development.md 5.3、D6）。
// 正式な判定（OS・RTC・時刻同期）はIssue #65で扱い、ここでは実装しない。

export type TimeAvailability = "available" | "unavailable";

export type ClockFaceKind = "clock" | "unavailable";

/** `unavailable`のときは日付と時刻を表示せず、未同期表示にする（UI設計 6.3）。 */
export function clockFaceKind(availability: TimeAvailability): ClockFaceKind {
  return availability === "available" ? "clock" : "unavailable";
}

/**
 * 日付と時刻をフェードで表示するか。未同期表示から利用可能へ移ったときだけフェードする。
 * 起動直後から利用可能な場合はフェードしない。
 */
export function shouldFadeInClock(
  previous: TimeAvailability,
  next: TimeAvailability,
): boolean {
  return previous === "unavailable" && next === "available";
}
