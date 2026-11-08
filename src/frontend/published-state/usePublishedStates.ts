import { useEffect, useState } from "react";
import {
  INITIAL_SNAPSHOT,
  startPolling,
  type PollingSnapshot,
} from "./polling";

/**
 * 表示用APIのPollingをReactにつなぐ。`App`の直下で1回だけ使う
 * （コンテンツは切替のたびに作り直されるため、そこでは取得しない。frontend-development 11.2）。
 * Unmount時にRequestとTimerを止める。
 */
export function usePublishedStates(): PollingSnapshot {
  const [snapshot, setSnapshot] = useState<PollingSnapshot>(INITIAL_SNAPSHOT);
  useEffect(() => startPolling(setSnapshot), []);
  return snapshot;
}

/** 現在時刻（ms）。Pollingを待たずに、1分ごとに表示を再評価する（frontend-development 11.4）。 */
export const RE_EVALUATE_MS = 60_000;
export function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), RE_EVALUATE_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
