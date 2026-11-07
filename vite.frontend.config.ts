import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Frontend専用のVite設定。Vitestが自動で読み込まないよう`vite.config.ts`とは別名にし、
// npm scriptsから`--config`で指定する。
//
// 通常（既定のmode）：root `src/frontend`、出力先 `dist/frontend/`。入力は`index.html`だけで、
//   検証専用エントリーポイント（`src/frontend/verify/`）は含まれない。
// 検証用（`--mode verify`）：root `src/frontend/verify`、出力先 `dist/frontend-verify/`（D13）。
const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ mode }) => {
  const verify = mode === "verify";
  return {
    root: resolve(verify ? "./src/frontend/verify" : "./src/frontend"),
    plugins: [react()],
    build: {
      outDir: resolve(verify ? "./dist/frontend-verify" : "./dist/frontend"),
      emptyOutDir: true,
    },
  };
});
