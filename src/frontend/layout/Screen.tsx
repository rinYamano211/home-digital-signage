import { useEffect, useState, type ReactNode } from "react";
import { fitScreen, type ScreenFit } from "./scale";

function currentFit(): ScreenFit {
  return fitScreen(window.innerWidth, window.innerHeight);
}

type Props = {
  /** 左45%の時計タイル。 */
  readonly clock: ReactNode;
};

/**
 * 1280×800の基本画面（L1：左に時計、右にコンテンツ領域）。
 * コンテンツ領域は#7では空のタイルとし、文言やダミーデータは表示しない。
 */
export function Screen({ clock }: Props) {
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
      {clock}
      <section className="tile content-tile" aria-label="コンテンツ" />
    </main>
  );
}
