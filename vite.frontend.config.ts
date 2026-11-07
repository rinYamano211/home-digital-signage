import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Frontend専用のVite設定。Vitestが自動で読み込まないよう`vite.config.ts`とは別名にし、
// npm scriptsから`--config`で指定する。
const root = fileURLToPath(new URL("./src/frontend", import.meta.url));
const outDir = fileURLToPath(new URL("./dist/frontend", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
  },
});
