// next.config.ts を検証する。
//
// 期待値の根拠:
// - docs/steps/step-7.md「実装するファイル」next.config.ts の役割
//   「X-Robots-Tag: noindex, nofollow を全パスに付ける」
// - next.config.ts 内のコメント（robots.txt を読まないクローラ対策）

import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

describe("next.config headers()", () => {
  it("全パス（'/:path*'）に X-Robots-Tag: noindex, nofollow を付ける", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const headers = await nextConfig.headers!();
    expect(headers).toEqual([
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ]);
  });
});
