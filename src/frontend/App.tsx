import {
  useMinuteNow,
  usePublishedStates,
} from "./published-state/usePublishedStates";
import { signageModel } from "./signage-model";
import { SignageScreen } from "./SignageScreen";

// 通常画面。表示用APIをPollingし、予定・天気を表示する（docs/frontend-development.md 第11・12章）。
// 正式な時刻利用可否の判定（Issue #65）がまだないため、時刻は`available`を固定で渡す（5.3）。
// 検証専用のコードはここからimportしない。
export function App() {
  const snapshot = usePublishedStates();
  const tick = useMinuteNow();
  // 1分ごと、およびResponseの更新時に、その時点の時刻で再評価する（11.4）。
  const model = signageModel(snapshot, Math.max(tick, snapshot.at));
  return (
    <SignageScreen
      time="available"
      displayable={model.displayable}
      notice={model.notice}
      context={model}
    />
  );
}
