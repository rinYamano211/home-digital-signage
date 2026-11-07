import { CONTENTS } from "./content/registry";
import { SignageScreen } from "./SignageScreen";

// #9・#10が入るまでは、すべての仮パネルを表示できるものとして扱う（docs/frontend-development.md 10.7）。
const ALL_DISPLAYABLE: ReadonlySet<string> = new Set(
  CONTENTS.map((content) => content.id),
);

// 通常画面。正式な時刻利用可否の判定（Issue #65）がまだないため、`available`を固定で渡す
// （docs/frontend-development.md 5.3）。検証専用のコードはここからimportしない。
export function App() {
  return <SignageScreen time="available" displayable={ALL_DISPLAYABLE} />;
}
