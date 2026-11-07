import { useEffect, useMemo, useRef, useState } from "react";
import type { TimeAvailability } from "../clock/availability";
import {
  ContentRotation,
  initialView,
  type RotationEntry,
  type RotationInput,
  type RotationView,
} from "./rotation";

/**
 * 切替のロジック（`ContentRotation`）をReactにつなぐ。Timerの管理と表示の受け渡しだけを行う
 * （docs/frontend-development.md 10.2 S1）。`entries`はモジュールの定数など、変わらない値を渡す。
 */
export function useContentRotation(
  entries: readonly RotationEntry[],
  displayable: ReadonlySet<string>,
  time: TimeAvailability,
): RotationView {
  // 中身が同じSetを毎回作っても、切替をやり直さないようにする。
  const displayableKey = [...displayable].sort().join("\n");
  const input = useMemo<RotationInput>(
    () => ({
      displayable: new Set(
        displayableKey === "" ? [] : displayableKey.split("\n"),
      ),
      time,
    }),
    [displayableKey, time],
  );

  const [view, setView] = useState(() => initialView(entries, input));
  const inputRef = useRef(input);
  const rotationRef = useRef<ContentRotation | null>(null);

  useEffect(() => {
    const rotation = new ContentRotation(entries, inputRef.current, setView);
    rotationRef.current = rotation;
    return () => {
      rotation.dispose();
      rotationRef.current = null;
    };
  }, [entries]);

  useEffect(() => {
    inputRef.current = input;
    rotationRef.current?.update(input);
  }, [input]);

  return view;
}
