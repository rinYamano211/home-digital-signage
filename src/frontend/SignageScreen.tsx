import type { ReactNode } from "react";
import type { TimeAvailability } from "./clock/availability";
import { ClockTile } from "./clock/ClockTile";
import { ContentArea } from "./content/ContentArea";
import { Indicator } from "./content/Indicator";
import { indicatorDots } from "./content/indicator-dots";
import {
  LoadingCard,
  NoContentCard,
  TimeUnavailableCard,
} from "./content/NoticeCards";
import { CONTENTS, type ContentContext } from "./content/registry";
import type { RotationView } from "./content/rotation";
import { useContentRotation } from "./content/useContentRotation";
import { Screen } from "./layout/Screen";
import type { NoContentNotice } from "./signage-model";

type Props = {
  /** 時刻の利用可否。時計タイルと切替の両方に渡す（docs/frontend-development.md 5.3・10.5）。 */
  readonly time: TimeAvailability;
  /** 現在表示できるコンテンツのid。判定はComponent State生成側が行う（10.5 S5、11.6）。 */
  readonly displayable: ReadonlySet<string>;
  /** 表示できるコンテンツが0件のときの1枚表示（UI設計 6.2・6.5）。 */
  readonly notice: NoContentNotice;
  /** 各コンテンツの描画に渡すComponent State。 */
  readonly context: ContentContext;
};

/** 通常画面と検証画面で共通の画面。時計は常時表示し、右側のコンテンツだけを切り替える。 */
export function SignageScreen({ time, displayable, notice, context }: Props) {
  const view = useContentRotation(CONTENTS, displayable, time);

  const renderView = (target: RotationView): ReactNode => {
    switch (target.kind) {
      case "timeUnavailable":
        return <TimeUnavailableCard />;
      case "noContent":
        return notice === "loading" ? <LoadingCard /> : <NoContentCard />;
      case "content":
        return CONTENTS.find((content) => content.id === target.id)?.render(
          context,
        );
    }
  };

  return (
    <Screen
      clock={<ClockTile availability={time} />}
      indicator={
        <Indicator dots={indicatorDots(CONTENTS, displayable, view)} />
      }
      content={<ContentArea view={view} renderView={renderView} />}
    />
  );
}
