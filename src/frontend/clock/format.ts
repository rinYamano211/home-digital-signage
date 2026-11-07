// 時計の表示文字列を作る純粋関数。OSのTimezone設定に依存しないよう、Asia/Tokyoを明示する
// （docs/architecture.md 10.3、docs/frontend-development.md 5.2）。

export const DISPLAY_TIME_ZONE = "Asia/Tokyo";

export type ClockText = {
  /** 例：`11月2日（月）` */
  readonly date: string;
  /** 例：`14:30`（24時間表記、秒なし、時は2桁） */
  readonly time: string;
};

const formatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: DISPLAY_TIME_ZONE,
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function part(
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  const found = parts.find((p) => p.type === type);
  if (found === undefined) {
    throw new Error(`Missing date part: ${type}`);
  }
  return found.value;
}

/**
 * 現在時刻（Unix epoch ms）から、時計タイルの日付と時刻の文字列を作る。
 * 括弧などの区切りは`Intl`の既定に頼らず、UI設計の表記に合わせて組み立てる。
 */
export function formatClock(epochMs: number): ClockText {
  const parts = formatter.formatToParts(epochMs);
  const month = part(parts, "month");
  const day = part(parts, "day");
  const weekday = part(parts, "weekday");
  const hour = part(parts, "hour");
  const minute = part(parts, "minute");
  return {
    date: `${month}月${day}日（${weekday}）`,
    time: `${hour}:${minute}`,
  };
}

/** 表示文字列が変わったときだけ表示を更新するための比較（D8）。 */
export function isSameClockText(a: ClockText, b: ClockText): boolean {
  return a.date === b.date && a.time === b.time;
}

/**
 * 1秒ごとの確認で使う更新規則。表示文字列が変わらなければ`current`をそのまま返す。
 * 同じオブジェクトを返すと、Reactは再描画を省く。
 */
export function nextClockText(current: ClockText, epochMs: number): ClockText {
  const next = formatClock(epochMs);
  return isSameClockText(current, next) ? current : next;
}
