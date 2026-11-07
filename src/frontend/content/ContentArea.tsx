import { useEffect, useState, type ReactNode } from "react";
import { sameView, type RotationView } from "./rotation";
import {
  CONTENT_TRANSITION_MS,
  finishTransition,
  initialPanels,
  startTransition,
  viewKey,
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
      {leaving !== null && (
        <div key={viewKey(leaving)} className="content-panel content-exit">
          {renderView(leaving)}
        </div>
      )}
      <div
        key={viewKey(panels.current)}
        className={
          panels.animate ? "content-panel content-enter" : "content-panel"
        }
      >
        {renderView(panels.current)}
      </div>
    </section>
  );
}
