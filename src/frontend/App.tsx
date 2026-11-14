import { useTimeAvailability } from "./clock/useTimeAvailability";
import {
  useMinuteNow,
  usePublishedStates,
} from "./published-state/usePublishedStates";
import { signageModel } from "./signage-model";
import { SignageScreen } from "./SignageScreen";

// 通常画面。表示用APIをPollingし、予定・天気を表示する（docs/frontend-development.md 第11・12章）。
// 時刻の利用可否は、表示用時刻のAPIから受け取って渡す（第13章、Issue #65）。
// 検証専用のコードはここからimportしない。
export function App() {
  const snapshot = usePublishedStates();
  const tick = useMinuteNow();
  const time = useTimeAvailability();
  // 1分ごと、Responseの更新時、時刻の利用可否が変わった時に、その時点の時刻で再評価する
  // （11.4・13.4）。
  const model = signageModel(
    snapshot,
    Math.max(tick, snapshot.at, time.changedAt),
  );
  return (
    <SignageScreen
      time={time.availability}
      displayable={model.displayable}
      notice={model.notice}
      context={model}
    />
  );
}
