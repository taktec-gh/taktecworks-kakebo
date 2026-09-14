// src/app/robots.ts を検証する。
//
// 期待値の根拠:
// - docs/steps/step-7.md「実装するファイル」robots.ts の役割「全クローラを拒否」
// - src/app/robots.ts 内のコメント（索引されると総当たりの標的になるため）

import { describe, expect, it } from "vitest";

import robots from "@/app/robots";

describe("robots", () => {
  it("全クローラ（userAgent: '*'）に対して全パス（'/'）を disallow する", () => {
    expect(robots()).toEqual({
      rules: { userAgent: "*", disallow: "/" },
    });
  });
});
