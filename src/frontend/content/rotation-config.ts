// コンテンツの表示時間の設定値（docs/frontend-development.md 10.4 S3・S4）。
// 切替のロジック・描画とは分けて、この値だけを変更できるようにする。
// 初期値はUI設計 4.2・第11章の暫定値（各コンテンツ10秒）。Raspberry Piの実機で読みやすさを確認して調整する。
// 変更は、このファイルを修正 → `npm run build:frontend` → Piへ転送で反映する。
// 利用者が変更する機能・設定UIはFuture（Issue #8）。

/** 切替コンテンツの識別子。MVPは3つで、順序は`content/registry.tsx`で定める。 */
export type ContentId = "schedule" | "todayWeather" | "weeklyWeather";

/** コンテンツごとの表示時間（ミリ秒）。 */
export const CONTENT_DURATION_MS: Readonly<Record<ContentId, number>> = {
  schedule: 10_000,
  todayWeather: 10_000,
  weeklyWeather: 10_000,
};
