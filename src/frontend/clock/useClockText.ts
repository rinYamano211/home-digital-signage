import { useEffect, useState } from "react";
import { formatClock, nextClockText, type ClockText } from "./format";

/** 現在時刻を確認する間隔。時刻の補正や日付の変更にも最大1秒で追従する（D8）。 */
export const CLOCK_TICK_MS = 1000;

/**
 * Browserの現在時刻（OS System Time）から時計の表示文字列を返す。
 * 1秒ごとに確認し、表示文字列が変わったときだけ再描画する。
 */
export function useClockText(): ClockText {
  const [text, setText] = useState(() => formatClock(Date.now()));

  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      setText((current) => nextClockText(current, now));
    }, CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  return text;
}
