// コンテンツ位置インジケーターの点の状態（UI設計 4.1・4.2、docs/frontend-development.md 10.3 S2）。
import type { RotationEntry, RotationView } from "./rotation";

/** `current`：表示中（横長のアクセント色）、`waiting`：巡回中、`skipped`：巡回から外れている（白抜き）。 */
export type DotState = "current" | "waiting" | "skipped";

export type IndicatorDot = {
  readonly id: string;
  readonly state: DotState;
};

/**
 * 各コンテンツの点の状態。1枚表示（時刻未同期・0件）の間は、表示中の点を出さない。
 * 表示できないコンテンツは、1枚表示の間も白抜きにする。
 */
export function indicatorDots(
  entries: readonly RotationEntry[],
  displayable: ReadonlySet<string>,
  view: RotationView,
): readonly IndicatorDot[] {
  return entries.map((entry) => {
    if (!displayable.has(entry.id)) {
      return { id: entry.id, state: "skipped" };
    }
    if (view.kind === "content" && view.id === entry.id) {
      return { id: entry.id, state: "current" };
    }
    return { id: entry.id, state: "waiting" };
  });
}
