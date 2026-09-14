// @vitest-environment node
//
// src/lib/budget-calculation.ts の金額パース・集計（純粋関数、DB非依存）を検証する。
//
// 期待値の根拠:
// - docs/features.md「設計判断 > 予算の持ち方」（払い出し先が主軸、カテゴリ予算は総予算に足さない）
// - docs/steps/step-4.md「予算の『未設定』と『0円』を区別する」
//   「無効な払い出し先に予算が残っている場合」
// - docs/steps/step-4.md「実装完了後の引き継ぎ > 特に確認したい観点」2・3・4・8
// - 金額の範囲は 0〜99,999,999（同「金額の入力規則」）
//
// 金額計算のテストには手計算の根拠をコメントで残す。

import { describe, expect, it } from "vitest";

import { PaymentSourceType } from "@/generated/prisma/enums";
import {
  BUDGET_AMOUNT_ERRORS,
  BUDGET_AMOUNT_MAX_YEN,
  BUDGET_AMOUNT_MIN_YEN,
  buildBudgetSummary,
  buildCategoryBudgetSummary,
  formatAmountInputValue,
  formatYen,
  parseBudgetAmountInput,
  sumAmounts,
  type BudgetPaymentSourceInput,
  type BudgetRecordInput,
  type CategoryBudgetCategoryInput,
  type CategoryBudgetRecordInput,
} from "@/lib/budget-calculation";

describe("定数", () => {
  it("金額の下限は0円", () => {
    expect(BUDGET_AMOUNT_MIN_YEN).toBe(0);
  });

  it("金額の上限は99,999,999円", () => {
    expect(BUDGET_AMOUNT_MAX_YEN).toBe(99_999_999);
  });
});

describe("parseBudgetAmountInput", () => {
  it("空文字は未設定（null）", () => {
    expect(parseBudgetAmountInput("")).toEqual({ ok: true, value: null });
  });

  it("半角空白のみは未設定（null）", () => {
    expect(parseBudgetAmountInput("   ")).toEqual({ ok: true, value: null });
  });

  it("全角空白のみは未設定（null）", () => {
    expect(parseBudgetAmountInput("　　")).toEqual({ ok: true, value: null });
  });

  it("'0' は0円の予算として扱う（未設定とは区別する）", () => {
    expect(parseBudgetAmountInput("0")).toEqual({ ok: true, value: 0 });
  });

  it("通常の整数文字列はそのまま数値になる", () => {
    expect(parseBudgetAmountInput("40000")).toEqual({ ok: true, value: 40000 });
  });

  it("全角数字は半角に正規化して受け入れる", () => {
    expect(parseBudgetAmountInput("４００００")).toEqual({ ok: true, value: 40000 });
  });

  it("半角カンマ区切りは正規化して受け入れる", () => {
    expect(parseBudgetAmountInput("40,000")).toEqual({ ok: true, value: 40000 });
  });

  it("全角カンマ区切りは正規化して受け入れる", () => {
    expect(parseBudgetAmountInput("40，000")).toEqual({ ok: true, value: 40000 });
  });

  it("前後の空白（半角・全角）は trim される", () => {
    expect(parseBudgetAmountInput("　40000　")).toEqual({ ok: true, value: 40000 });
  });

  it("マイナスの値は拒否する", () => {
    expect(parseBudgetAmountInput("-100")).toEqual({
      ok: false,
      error: BUDGET_AMOUNT_ERRORS.negative,
    });
  });

  it.each(["-100", "−100", "－100"])("マイナス記号の異表記 '%s' も拒否する", (value) => {
    expect(parseBudgetAmountInput(value)).toEqual({
      ok: false,
      error: BUDGET_AMOUNT_ERRORS.negative,
    });
  });

  it("小数は拒否する（1円単位の整数のみ）", () => {
    expect(parseBudgetAmountInput("100.5")).toEqual({
      ok: false,
      error: BUDGET_AMOUNT_ERRORS.notInteger,
    });
  });

  it("全角の小数点も拒否する", () => {
    expect(parseBudgetAmountInput("１００．５")).toEqual({
      ok: false,
      error: BUDGET_AMOUNT_ERRORS.notInteger,
    });
  });

  it("数字でない文字列は拒否する", () => {
    expect(parseBudgetAmountInput("abc")).toEqual({
      ok: false,
      error: BUDGET_AMOUNT_ERRORS.invalid,
    });
  });

  it("指数表記は拒否する", () => {
    expect(parseBudgetAmountInput("1e5")).toEqual({
      ok: false,
      error: BUDGET_AMOUNT_ERRORS.invalid,
    });
  });

  it("文字列以外の入力は invalid", () => {
    expect(parseBudgetAmountInput(null)).toEqual({
      ok: false,
      error: BUDGET_AMOUNT_ERRORS.invalid,
    });
    expect(parseBudgetAmountInput(40000)).toEqual({
      ok: false,
      error: BUDGET_AMOUNT_ERRORS.invalid,
    });
  });

  it("上限ちょうど（99,999,999）は通る（境界値）", () => {
    expect(parseBudgetAmountInput("99999999")).toEqual({ ok: true, value: 99_999_999 });
  });

  it("上限を1円超えると拒否する（境界値）", () => {
    expect(parseBudgetAmountInput("100000000")).toEqual({
      ok: false,
      error: BUDGET_AMOUNT_ERRORS.tooLarge,
    });
  });

  it("極端に大きい桁数（安全な整数を超える）は拒否する", () => {
    expect(parseBudgetAmountInput("99999999999999999999")).toEqual({
      ok: false,
      error: BUDGET_AMOUNT_ERRORS.tooLarge,
    });
  });
});

describe("formatYen", () => {
  it("0円は '¥0'", () => {
    expect(formatYen(0)).toBe("¥0");
  });

  it("3桁区切りでカンマが入る", () => {
    expect(formatYen(40000)).toBe("¥40,000");
  });

  it("大きな金額でも3桁ごとに区切る", () => {
    expect(formatYen(12345678)).toBe("¥12,345,678");
  });
});

describe("formatAmountInputValue", () => {
  it("null は空文字（未設定を入力欄に反映する）", () => {
    expect(formatAmountInputValue(null)).toBe("");
  });

  it("0 は '0'（未設定の空文字とは区別する）", () => {
    expect(formatAmountInputValue(0)).toBe("0");
  });

  it("通常の金額はそのまま文字列になる", () => {
    expect(formatAmountInputValue(40000)).toBe("40000");
  });
});

describe("sumAmounts", () => {
  it("空配列は0", () => {
    expect(sumAmounts([])).toBe(0);
  });

  it("複数件の合計", () => {
    expect(sumAmounts([{ amountYen: 100 }, { amountYen: 200 }, { amountYen: 0 }])).toBe(300);
  });
});

function paymentSource(
  overrides: Partial<BudgetPaymentSourceInput>,
): BudgetPaymentSourceInput {
  return {
    id: "ps_1",
    sortOrder: 1,
    isActive: true,
    name: "現金",
    type: PaymentSourceType.CASH,
    ...overrides,
  };
}

describe("buildBudgetSummary", () => {
  it("払い出し先が1件も無ければ全て空・合計0", () => {
    const summary = buildBudgetSummary([], []);
    expect(summary).toEqual({ rows: [], inactiveRows: [], totalYen: 0, unsetCount: 0 });
  });

  it("有効な払い出し先は rows に入り、無効な払い出し先（予算無し）は出ない", () => {
    const sources = [
      paymentSource({ id: "a1", isActive: true, sortOrder: 1, name: "現金" }),
      paymentSource({ id: "b1", isActive: false, sortOrder: 2, name: "使わないカード" }),
    ];
    const summary = buildBudgetSummary(sources, []);
    expect(summary.rows.map((r) => r.paymentSourceId)).toEqual(["a1"]);
    expect(summary.inactiveRows).toEqual([]);
  });

  it("有効な払い出し先に予算が無ければ amountYen は null（未設定）", () => {
    const sources = [paymentSource({ id: "a1", isActive: true })];
    const summary = buildBudgetSummary(sources, []);
    expect(summary.rows[0]?.amountYen).toBeNull();
  });

  it("amountYen: 0 と未設定（null）は区別される", () => {
    const sources = [
      paymentSource({ id: "a1", isActive: true, sortOrder: 1 }),
      paymentSource({ id: "a2", isActive: true, sortOrder: 2 }),
    ];
    const budgets: BudgetRecordInput[] = [{ paymentSourceId: "a1", amountYen: 0 }];
    const summary = buildBudgetSummary(sources, budgets);
    const a1 = summary.rows.find((r) => r.paymentSourceId === "a1");
    const a2 = summary.rows.find((r) => r.paymentSourceId === "a2");
    expect(a1?.amountYen).toBe(0);
    expect(a2?.amountYen).toBeNull();
  });

  it("unsetCount は有効な払い出し先のうち未設定の件数のみを数える（0円は含めない）", () => {
    const sources = [
      paymentSource({ id: "a1", isActive: true, sortOrder: 1 }),
      paymentSource({ id: "a2", isActive: true, sortOrder: 2 }),
      paymentSource({ id: "a3", isActive: true, sortOrder: 3 }),
    ];
    const budgets: BudgetRecordInput[] = [{ paymentSourceId: "a1", amountYen: 0 }];
    const summary = buildBudgetSummary(sources, budgets);
    // a1=0円(設定済み), a2・a3=未設定 → unsetCount=2
    expect(summary.unsetCount).toBe(2);
  });

  it("無効な払い出し先に予算が残っていれば inactiveRows に入り、rows には入らない", () => {
    const sources = [
      paymentSource({ id: "a1", isActive: true, sortOrder: 1 }),
      paymentSource({ id: "b1", isActive: false, sortOrder: 2, name: "旧カード" }),
    ];
    const budgets: BudgetRecordInput[] = [{ paymentSourceId: "b1", amountYen: 5000 }];
    const summary = buildBudgetSummary(sources, budgets);
    expect(summary.rows.map((r) => r.paymentSourceId)).toEqual(["a1"]);
    expect(summary.inactiveRows).toEqual([
      { paymentSourceId: "b1", name: "旧カード", type: PaymentSourceType.CASH, isActive: false, amountYen: 5000 },
    ]);
  });

  it("totalYen は無効な払い出し先の予算も含めた全 Budget レコードの合計（画面と実データを食い違わせない）", () => {
    // 手計算: 現金(有効,10000) + 旧カード(無効,5000) = 15000
    const sources = [
      paymentSource({ id: "a1", isActive: true, sortOrder: 1, name: "現金" }),
      paymentSource({ id: "b1", isActive: false, sortOrder: 2, name: "旧カード" }),
    ];
    const budgets: BudgetRecordInput[] = [
      { paymentSourceId: "a1", amountYen: 10_000 },
      { paymentSourceId: "b1", amountYen: 5_000 },
    ];
    const summary = buildBudgetSummary(sources, budgets);
    expect(summary.totalYen).toBe(15_000);
  });

  it("totalYen はどの払い出し先とも紐付かない Budget レコードも含める（黙って除外しない）", () => {
    const sources = [paymentSource({ id: "a1", isActive: true })];
    const budgets: BudgetRecordInput[] = [{ paymentSourceId: "orphan", amountYen: 3_000 }];
    const summary = buildBudgetSummary(sources, budgets);
    expect(summary.totalYen).toBe(3_000);
    // rows・inactiveRows のどちらにも現れない（一覧に存在しない払い出し先のため）
    expect(summary.rows.every((r) => r.paymentSourceId !== "orphan")).toBe(true);
    expect(summary.inactiveRows.every((r) => r.paymentSourceId !== "orphan")).toBe(true);
  });

  it("rows は表示順（sortPaymentSources と同じ規則）に並ぶ", () => {
    const sources = [
      paymentSource({ id: "a2", isActive: true, sortOrder: 2, name: "Aカード" }),
      paymentSource({ id: "a1", isActive: true, sortOrder: 1, name: "現金" }),
    ];
    const summary = buildBudgetSummary(sources, []);
    expect(summary.rows.map((r) => r.paymentSourceId)).toEqual(["a1", "a2"]);
  });

  it("すべて無効な払い出し先でも rows は空、合計にはその予算が入る", () => {
    const sources = [paymentSource({ id: "b1", isActive: false, sortOrder: 1 })];
    const budgets: BudgetRecordInput[] = [{ paymentSourceId: "b1", amountYen: 1_000 }];
    const summary = buildBudgetSummary(sources, budgets);
    expect(summary.rows).toEqual([]);
    expect(summary.totalYen).toBe(1_000);
  });
});

function category(overrides: Partial<CategoryBudgetCategoryInput>): CategoryBudgetCategoryInput {
  return {
    id: "cat_1",
    sortOrder: 1,
    isHidden: false,
    name: "食費",
    ...overrides,
  };
}

describe("buildCategoryBudgetSummary", () => {
  it("カテゴリが1件も無ければ空・合計0", () => {
    expect(buildCategoryBudgetSummary([], [])).toEqual({ rows: [], totalYen: 0, setCount: 0 });
  });

  it("表示中のカテゴリは予算未設定でも rows に入る（amountYen は null）", () => {
    const categories = [category({ id: "c1", isHidden: false })];
    const summary = buildCategoryBudgetSummary(categories, []);
    expect(summary.rows).toEqual([
      { categoryId: "c1", name: "食費", isHidden: false, amountYen: null },
    ]);
  });

  it("非表示のカテゴリは予算が無ければ rows に出ない", () => {
    const categories = [category({ id: "c1", isHidden: true })];
    const summary = buildCategoryBudgetSummary(categories, []);
    expect(summary.rows).toEqual([]);
  });

  it("非表示のカテゴリでも予算が残っていれば rows に出る（消せるようにするため）", () => {
    const categories = [category({ id: "c1", isHidden: true, name: "旧カテゴリ" })];
    const budgets: CategoryBudgetRecordInput[] = [{ categoryId: "c1", amountYen: 2_000 }];
    const summary = buildCategoryBudgetSummary(categories, budgets);
    expect(summary.rows).toEqual([
      { categoryId: "c1", name: "旧カテゴリ", isHidden: true, amountYen: 2_000 },
    ]);
  });

  it("amountYen: 0 と未設定（null）は区別される", () => {
    const categories = [
      category({ id: "c1", sortOrder: 1 }),
      category({ id: "c2", sortOrder: 2 }),
    ];
    const budgets: CategoryBudgetRecordInput[] = [{ categoryId: "c1", amountYen: 0 }];
    const summary = buildCategoryBudgetSummary(categories, budgets);
    expect(summary.rows.find((r) => r.categoryId === "c1")?.amountYen).toBe(0);
    expect(summary.rows.find((r) => r.categoryId === "c2")?.amountYen).toBeNull();
  });

  it("setCount は amountYen が null でない行のみ数える（0円は『設定済み』として数える）", () => {
    const categories = [
      category({ id: "c1", sortOrder: 1 }),
      category({ id: "c2", sortOrder: 2 }),
      category({ id: "c3", sortOrder: 3 }),
    ];
    const budgets: CategoryBudgetRecordInput[] = [
      { categoryId: "c1", amountYen: 0 },
      { categoryId: "c2", amountYen: 3_000 },
    ];
    const summary = buildCategoryBudgetSummary(categories, budgets);
    expect(summary.setCount).toBe(2);
  });

  it("totalYen はカテゴリ予算レコードの単純合計", () => {
    // 手計算: 食費(5000) + 日用品(2000) = 7000
    const categories = [
      category({ id: "c1", sortOrder: 1, name: "食費" }),
      category({ id: "c2", sortOrder: 2, name: "日用品" }),
    ];
    const budgets: CategoryBudgetRecordInput[] = [
      { categoryId: "c1", amountYen: 5_000 },
      { categoryId: "c2", amountYen: 2_000 },
    ];
    const summary = buildCategoryBudgetSummary(categories, budgets);
    expect(summary.totalYen).toBe(7_000);
  });

  it("rows は表示順（sortCategories と同じ規則）に並ぶ", () => {
    const categories = [
      category({ id: "c2", sortOrder: 2, name: "日用品" }),
      category({ id: "c1", sortOrder: 1, name: "食費" }),
    ];
    const summary = buildCategoryBudgetSummary(categories, []);
    expect(summary.rows.map((r) => r.categoryId)).toEqual(["c1", "c2"]);
  });
});

describe("総予算にカテゴリ予算が混ざらないこと（features.md「予算の持ち方」）", () => {
  it("同じ月にカテゴリ予算が存在しても、buildBudgetSummary の totalYen は払い出し先の予算だけの合計になる", () => {
    // 手計算: 払い出し先の予算合計 = 40000(現金) + 50000(Aカード) = 90000
    // カテゴリ予算合計 = 20000(食費) + 10000(日用品) = 30000 だが、これは totalYen に一切含まれない
    const sources = [
      paymentSource({ id: "a1", isActive: true, sortOrder: 1, name: "現金" }),
      paymentSource({ id: "a2", isActive: true, sortOrder: 2, name: "Aカード" }),
    ];
    const budgets: BudgetRecordInput[] = [
      { paymentSourceId: "a1", amountYen: 40_000 },
      { paymentSourceId: "a2", amountYen: 50_000 },
    ];
    const categories = [
      category({ id: "c1", sortOrder: 1, name: "食費" }),
      category({ id: "c2", sortOrder: 2, name: "日用品" }),
    ];
    const categoryBudgets: CategoryBudgetRecordInput[] = [
      { categoryId: "c1", amountYen: 20_000 },
      { categoryId: "c2", amountYen: 10_000 },
    ];

    const budgetSummary = buildBudgetSummary(sources, budgets);
    const categoryBudgetSummary = buildCategoryBudgetSummary(categories, categoryBudgets);

    expect(budgetSummary.totalYen).toBe(90_000);
    expect(categoryBudgetSummary.totalYen).toBe(30_000);
    // buildBudgetSummary は categoryBudgets を引数にすら取らないため、
    // 構造的にカテゴリ予算が総予算へ混入する余地が無いことも確認する
    expect(buildBudgetSummary).toHaveLength(2);
  });
});
