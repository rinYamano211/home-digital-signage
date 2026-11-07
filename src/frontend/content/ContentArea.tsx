import { useEffect, useState, type ReactNode } from "react";
import { sameView, type RotationView } from "./rotation";
import {
  CONTENT_TRANSITION_MS,
  finishTransition,
  initialPanels,
  renderedPanels,
  startTransition,
} from "./transition";

type Props = {
  readonly view: RotationView;
  readonly renderView: (view: RotationView) => ReactNode;
};

/**
 * 右55%のコンテンツ領域。表示が変わったら、フェード＋少し上へ（約0.6秒）で切り替える
 * （UI設計 4.2・第7章、docs/frontend-development.md 10.6 6）。
 */
export function ContentArea({ view, renderView }: Props) {
  const [panels, setPanels] = useState(() => initialPanels(view));
  if (!sameView(panels.current, view)) {
    setPanels(startTransition(panels, view));
  }

  // 抜けていく表示が変わるたびにTimerを設定し直す。アニメーション中に表示が変わった場合も、
  // 前のTimerは解除され、新しく抜けていく表示の分だけ待つ。
  const leaving = panels.leaving;
  useEffect(() => {
    if (leaving === null) {
      return;
    }
    const id = window.setTimeout(
      () => setPanels(finishTransition),
      CONTENT_TRANSITION_MS + 50,
    );
    return () => window.clearTimeout(id);
  }, [leaving]);

  return (
    <section className="content-area" aria-label="コンテンツ">
      {renderedPanels(panels).map((panel) => (
        <div key={panel.key} className={panel.className}>
          {renderView(panel.view)}
        </div>
      ))}
    </section>
  );
}
