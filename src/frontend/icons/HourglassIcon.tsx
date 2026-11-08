// 砂時計のアイコン（UI設計 6.5「取得しています」）。このプロジェクトで描いたSVG。
// 回転などの常時動く演出は付けない（UI設計 第7章）。

type Props = {
  readonly className?: string;
};

export function HourglassIcon({ className }: Props) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h12" />
      <path d="M6 21h12" />
      <path d="M7 3v3a5 5 0 0 0 5 5a5 5 0 0 0 5 -5v-3" />
      <path d="M7 21v-3a5 5 0 0 1 5 -5a5 5 0 0 1 5 5v3" />
    </svg>
  );
}
