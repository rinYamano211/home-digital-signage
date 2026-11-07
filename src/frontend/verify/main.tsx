// 時刻未同期表示の検証専用エントリーポイント（D13、docs/frontend-development.md 5.3）。
// 通常画面と同じ時計コンポーネントに`available` / `unavailable`を手動で渡す。
// 通常Build（dist/frontend/）には含めず、検証用Build（dist/frontend-verify/）だけに出力する。
// この画面は表示の切替を確かめるもので、正式な時刻利用可否の判定は保証しない。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/fonts";
import "../styles/theme.css";
import "./verify.css";
import { VerifyApp } from "./VerifyApp";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Root element #root was not found.");
}

createRoot(container).render(
  <StrictMode>
    <VerifyApp />
  </StrictMode>,
);
