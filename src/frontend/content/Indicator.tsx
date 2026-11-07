import type { IndicatorDot } from "./indicator-dots";

type Props = {
  readonly dots: readonly IndicatorDot[];
};

/**
 * コンテンツ位置インジケーター（UI設計 4.1・4.2）。時計とは別のComponentとし、
 * Layout（Screen）が時計タイルの下部に重ねて配置する（docs/frontend-development.md 10.3 S2）。
 */
export function Indicator({ dots }: Props) {
  return (
    <div className="indicator" aria-hidden="true">
      {dots.map((dot) => (
        <span key={dot.id} className={`indicator-dot dot-${dot.state}`} />
      ))}
    </div>
  );
}
