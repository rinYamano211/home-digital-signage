// 切替コンテンツの定義（Registry、docs/frontend-development.md 10.2 S1）。
// 配列の順が巡回の順序になる。MVPは「今日の予定 → 今日の天気 → 週間天気」の固定順（要件 R-04）。
// コンテンツを追加するときは、定義を1件作ってこの配列に加える。切替のロジックは変更しない。
import type { ReactNode } from "react";
import type { ScheduleView } from "../schedule/schedule-state";
import { SchedulePanel } from "../schedule/SchedulePanel";
import { PlaceholderPanel } from "./PlaceholderPanel";
import { CONTENT_DURATION_MS, type ContentId } from "./rotation-config";
import type { RotationEntry } from "./rotation";

/** 各コンテンツの描画に渡す、Component State（docs/frontend-development.md 11.2）。 */
export type ContentContext = {
  readonly schedule: ScheduleView;
};

export type ContentDefinition = RotationEntry & {
  readonly id: ContentId;
  /** コンテンツの名前。 */
  readonly label: string;
  /** コンテンツ領域（約680×768px）の中身を描画する。 */
  readonly render: (context: ContentContext) => ReactNode;
};

// 今日の予定は#10で実データを表示する（第11章）。天気は#9が入るまで、コンテンツ名だけの
// 仮パネルを表示し、偽のデータは表示しない（10.7 S7）。
export const CONTENTS: readonly ContentDefinition[] = [
  {
    id: "schedule",
    label: "今日の予定",
    durationMs: CONTENT_DURATION_MS.schedule,
    render: ({ schedule }) => <SchedulePanel view={schedule} />,
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
