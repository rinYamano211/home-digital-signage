// 切替コンテンツの定義（Registry、docs/frontend-development.md 10.2 S1）。
// 配列の順が巡回の順序になる。MVPは「今日の予定 → 今日の天気 → 週間天気」の固定順（要件 R-04）。
// コンテンツを追加するときは、定義を1件作ってこの配列に加える。切替のロジックは変更しない。
import type { ReactNode } from "react";
import { PlaceholderPanel } from "./PlaceholderPanel";
import { CONTENT_DURATION_MS, type ContentId } from "./rotation-config";
import type { RotationEntry } from "./rotation";

export type ContentDefinition = RotationEntry & {
  readonly id: ContentId;
  /** コンテンツの名前。 */
  readonly label: string;
  /** コンテンツ領域（約680×768px）の中身を描画する。 */
  readonly render: () => ReactNode;
};

// #9・#10が入るまでは、コンテンツ名だけの仮パネルを表示する（10.7 S7）。
// 予定や天気の偽のデータは表示しない。#9・#10で`render`を実際のコンテンツに差し替える。
export const CONTENTS: readonly ContentDefinition[] = [
  {
    id: "schedule",
    label: "今日の予定",
    durationMs: CONTENT_DURATION_MS.schedule,
    render: () => <PlaceholderPanel label="今日の予定" />,
  },
  {
    id: "todayWeather",
    label: "今日の天気",
    durationMs: CONTENT_DURATION_MS.todayWeather,
    render: () => <PlaceholderPanel label="今日の天気" />,
  },
  {
    id: "weeklyWeather",
    label: "週間天気",
    durationMs: CONTENT_DURATION_MS.weeklyWeather,
    render: () => <PlaceholderPanel label="週間天気" />,
  },
];
