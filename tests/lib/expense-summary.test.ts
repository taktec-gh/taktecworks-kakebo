// @vitest-environment node
//
// src/lib/expense-summary.ts の集計（純粋関数・DB非依存）を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > 一覧は月単位」
//   「絞り込んだ結果の合計金額と件数を一覧の先頭に出す」
// - docs/steps/step-5.md「実装完了後の引き継ぎ > 特に確認したい観点」9.
//   「summarizeExpenses が空配列で byWasteTag の3キーがすべて0件0円で存在すること」
//
// 金額の手計算は各テストにコメントで残す。

import { describe, expect, it } from "vitest";

import { WasteTag } from "@/generated/prisma/enums";
import { groupExpenseTotals, summarizeExpenses } from "@/lib/expense-summary";

function expense(amountYen: number, wasteTag: WasteTag) {
  return { amountYen, wasteTag };
}

describe("summarizeExpenses — 空配列", () => {
  it("count=0, totalYen=0", () => {
    const summary = summarizeExpenses([]);
    expect(summary.count).toBe(0);
    expect(summary.totalYen).toBe(0);
  });

  it("byWasteTag は3タグすべてが0件0円で必ず存在する（キーの有無で分岐させないため）", () => {
    const summary = summarizeExpenses([]);
    expect(summary.byWasteTag).toEqual({
      [WasteTag.NECESSARY]: { count: 0, totalYen: 0 },
      [WasteTag.WASTE]: { count: 0, totalYen: 0 },
      [WasteTag.INVESTMENT]: { count: 0, totalYen: 0 },
    });
  });
});

describe("summarizeExpenses — 集計", () => {
  it("合計金額と件数を積み上げる", () => {
    // 手計算: 1000(必要) + 2000(浪費) + 500(投資) = 3500円、3件
    const summary = summarizeExpenses([
      expense(1000, WasteTag.NECESSARY),
      expense(2000, WasteTag.WASTE),
      expense(500, WasteTag.INVESTMENT),
    ]);
    expect(summary.count).toBe(3);
    expect(summary.totalYen).toBe(3500);
  });

  it("浪費タグ別の内訳が正しい", () => {
    // 必要: 1000+3000=4000円2件、浪費: 2000円1件、投資: 0件0円
    const summary = summarizeExpenses([
      expense(1000, WasteTag.NECESSARY),
      expense(3000, WasteTag.NECESSARY),
      expense(2000, WasteTag.WASTE),
    ]);
    expect(summary.byWasteTag[WasteTag.NECESSARY]).toEqual({ count: 2, totalYen: 4000 });
    expect(summary.byWasteTag[WasteTag.WASTE]).toEqual({ count: 1, totalYen: 2000 });
    expect(summary.byWasteTag[WasteTag.INVESTMENT]).toEqual({ count: 0, totalYen: 0 });
  });

  it("0円の要素は起こりえないが、あっても合計に含める（境界値としての堅牢性）", () => {
    const summary = summarizeExpenses([expense(0, WasteTag.NECESSARY)]);
    expect(summary.count).toBe(1);
    expect(summary.totalYen).toBe(0);
  });

  it("極端に大きい金額でも正しく積算する", () => {
    const summary = summarizeExpenses([
      expense(99_999_999, WasteTag.NECESSARY),
      expense(99_999_999, WasteTag.NECESSARY),
    ]);
    expect(summary.totalYen).toBe(199_999_998);
  });
});

describe("groupExpenseTotals", () => {
  it("キーごとに件数と金額を積み上げる", () => {
    const totals = groupExpenseTotals(
      [
        { amountYen: 1000, key: "cat_1" },
        { amountYen: 2000, key: "cat_1" },
        { amountYen: 500, key: "cat_2" },
      ],
      (item) => item.key,
    );
    expect(totals.get("cat_1")).toEqual({ count: 2, totalYen: 3000 });
    expect(totals.get("cat_2")).toEqual({ count: 1, totalYen: 500 });
  });

  it("空配列は空の Map", () => {
    const totals = groupExpenseTotals([], () => "x");
    expect(totals.size).toBe(0);
  });

  it("キーの出現順を保つ", () => {
    const totals = groupExpenseTotals(
      [
        { amountYen: 100, key: "b" },
        { amountYen: 100, key: "a" },
      ],
      (item) => item.key,
    );
    expect([...totals.keys()]).toEqual(["b", "a"]);
  });
});
