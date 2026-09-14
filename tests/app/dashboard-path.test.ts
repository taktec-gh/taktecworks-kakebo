// src/app/dashboard-path.ts の純粋関数・定数を検証する。
//
// この値は複数箇所（月ナビゲーションの hrefForMonth、各画面の「ホームへ」リンク、
// Server Action の revalidatePath("/") など）から参照されるため、
// 文字列が変わると気づかれにくい形で壊れる。直接テストして固定する。
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-5. 画面 > /（ダッシュボード）」冒頭
//   「/（ダッシュボード）— src/app/page.tsx を置き換える。月は ?month=YYYY-MM」
// - docs/steps/step-6.md「tester への引き継ぎ > そのほかの判断」
//   「ダッシュボードのパスは /、月のクエリ名は month（予算・支出と同じ）」

import { describe, expect, it } from "vitest";

import { DASHBOARD_PATH, dashboardPath, YEAR_MONTH_PARAM } from "@/app/dashboard-path";

describe("DASHBOARD_PATH / YEAR_MONTH_PARAM", () => {
  it("DASHBOARD_PATH は '/'", () => {
    expect(DASHBOARD_PATH).toBe("/");
  });

  it("YEAR_MONTH_PARAM は 'month'（予算・支出画面と同じクエリ名）", () => {
    expect(YEAR_MONTH_PARAM).toBe("month");
  });
});

describe("dashboardPath", () => {
  it("対象月を month クエリとして付けた URL を組み立てる", () => {
    expect(dashboardPath("2026-08")).toBe("/?month=2026-08");
  });

  it("月をまたいだ値でもそのまま組み立てる（境界: 12月）", () => {
    expect(dashboardPath("2026-12")).toBe("/?month=2026-12");
  });

  it("値を URL エンコードする", () => {
    // 通常 "YYYY-MM" は URL エンコードで変化しないが、
    // 想定外の値が渡っても壊れた URL にならないことを固定する
    expect(dashboardPath("2026 08")).toBe("/?month=2026%2008");
  });
});
