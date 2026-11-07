import { ClockTile } from "./clock/ClockTile";
import { Screen } from "./layout/Screen";

// 通常画面。正式な時刻利用可否の判定（Issue #65）がまだないため、`available`を固定で渡す
// （docs/frontend-development.md 5.3）。検証専用のコードはここからimportしない。
export function App() {
  return <Screen clock={<ClockTile availability="available" />} />;
}
