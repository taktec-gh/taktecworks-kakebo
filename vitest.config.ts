import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * 単体テストの実行設定。
 *
 * - `@/...` を `src/...` に解決する（実装が `@/lib/auth` 形式で import しているため）
 * - React コンポーネントのテストのため jsdom を既定環境にする
 * - jose の Web Crypto など Node の実装をそのまま使いたいファイルは
 *   先頭に `// @vitest-environment node` を書いて個別に切り替える
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
