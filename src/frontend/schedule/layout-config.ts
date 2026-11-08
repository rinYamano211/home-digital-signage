// 予定パネルの行の高さの目安（px）。UI設計 5.1の目安（通常 約28px、大 約38px、終了済み 約24px の文字）
// とUIモック（docs/ui-mock/signage-mock.html）の行間から求めた初期値。
// Raspberry Piの実機で、収まり方を見て調整する（UI設計 第12章）。CSS（styles/theme.css）と合わせて変える。
export const SCHEDULE_LAYOUT = {
  /** 予定パネルの内側の高さ（コンテンツ領域768px − 上下の余白24px×2）。 */
  panelHeight: 720,
  /** 「更新待ち」の札で増える上の余白（60px − 24px）。 */
  staleBadgeExtra: 36,
  /** 通常の行（28px × 行間1.85）。 */
  row: 52,
  /** 終了済みの行（24px × 行間1.85）。 */
  endedRow: 44,
  /** 終了済みを集約した1行（44px＋点線）。 */
  summaryRow: 46,
  /** 大きく表示する1件（ラベル＋38px × 行間1.4＋上下の余白）。 */
  bigBlock: 110,
  /** 終日のチップ1行（24px＋上下4px）と、その下の余白。 */
  chipRow: 44,
  chipsMargin: 12,
  /** 1行に並ぶチップの目安。長いタイトルが多い日は実機で確認する。 */
  chipsPerRow: 3,
  /** `ほか N件`の行。 */
  moreRow: 42,
} as const;
