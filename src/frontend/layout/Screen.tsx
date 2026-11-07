import { useEffect, useState, type ReactNode } from "react";
import { fitScreen, type ScreenFit } from "./scale";

function currentFit(): ScreenFit {
  return fitScreen(window.innerWidth, window.innerHeight);
}

type Props = {
  /** 左45%の時計タイル。ContentSwitcherを経由せず直接配置する（docs/architecture.md 6.3）。 */
  readonly clock: ReactNode;
  /** 時計タイルの下部に重ねるコンテンツ位置インジケーター（docs/frontend-development.md 10.3）。 */
  readonly indicator: ReactNode;
  /** 右55%のコンテンツ領域。 */
  readonly content: ReactNode;
};

/**
 * 1280×800の基本画面（L1：左に時計、右にコンテンツ領域）。
 * Layoutは配置位置と領域だけを扱い、表示内容の判断は持たない。
 */
export function Screen({ clock, indicator, content }: Props) {
  const [fit, setFit] = useState(currentFit);

  useEffect(() => {
    const onResize = () => setFit(currentFit());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <main
      className="screen"
      style={{
        transform: `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${fit.scale})`,
      }}
    >
      <div className="clock-column">
        {clock}
        {indicator}
      </div>
      {content}
    </main>
  );
}
