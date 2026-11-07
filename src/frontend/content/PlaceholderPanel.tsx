type Props = {
  readonly label: string;
};

/** #9・#10が入るまでの仮パネル。コンテンツ名だけを表示し、データは表示しない（10.7 S7）。 */
export function PlaceholderPanel({ label }: Props) {
  return (
    <div className="tile placeholder-panel">
      <div className="placeholder-label">{label}</div>
    </div>
  );
}
