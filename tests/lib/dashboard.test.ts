// @vitest-environment node
//
// src/lib/dashboard.ts の計算（純粋関数）を検証する。**Step 6 の中心**。
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-1. src/lib/dashboard.ts」の各表・端数の規則
// - docs/steps/step-6.md「tester への引き継ぎ > テストで押さえてほしい観点」
// - 手計算（コメントに根拠を残す）
//
// roadmap.md の Step 6 完了条件「残高・ペース・着地見込みのテストが通る」を
// 最も直接的に満たすファイル。

import { describe, expect, it } from "vitest";

import { CostType, PaymentSourceType } from "@/generated/prisma/enums";
import {
  buildCategoryProgressRows,
  buildDashboardSummary,
  buildIncomeBalance,
  buildPaymentSourceProgressRows,
  calculateExpectedYen,
  calculateProjectedYen,
  calculateUsageRatio,
  formatSignedYen,
  getMonthProgress,
  getUsageBarPercent,
  judgePaceStatus,
  PACE_STATUS_LABELS,
  PACE_WARNING_RATIO,
  summarizeIncomes,
  type DashboardCategoryInput,
  type DashboardPaymentSourceInput,
} from "@/lib/dashboard";

/* ------------------------------------------------------------------ *
 * getMonthProgress
 * ------------------------------------------------------------------ */

describe("getMonthProgress", () => {
  it("当月は経過日数が『今日の日』そのもの（8/14 → 14）", () => {
    const progress = getMonthProgress("2026-08", "2026-08-14");
    expect(progress).toEqual({
      yearMonth: "2026-08",
      daysInMonth: 31,
      elapsedDays: 14,
      elapsedRatio: 14 / 31,
      kind: "current",
    });
  });

  it("当月の月末（8/31）は elapsedDays が daysInMonth と一致し elapsedRatio が 1", () => {
    const progress = getMonthProgress("2026-08", "2026-08-31");
    expect(progress.elapsedDays).toBe(31);
    expect(progress.daysInMonth).toBe(31);
    expect(progress.elapsedRatio).toBe(1);
    expect(progress.kind).toBe("current");
  });

  it("当月の月初（8/1）は elapsedDays が 1", () => {
    const progress = getMonthProgress("2026-08", "2026-08-01");
    expect(progress.elapsedDays).toBe(1);
  });

  it("過去月は elapsedDays = daysInMonth（すべて経過）", () => {
    // 2026-07 は31日。今日が2026-08-14でも7月は「過ぎた月」として全日数を使う
    const progress = getMonthProgress("2026-07", "2026-08-14");
    expect(progress).toEqual({
      yearMonth: "2026-07",
      daysInMonth: 31,
      elapsedDays: 31,
      elapsedRatio: 1,
      kind: "past",
    });
  });

  it("未来月は elapsedDays = 0、elapsedRatio = 0", () => {
    const progress = getMonthProgress("2026-09", "2026-08-14");
    expect(progress).toEqual({
      yearMonth: "2026-09",
      daysInMonth: 30,
      elapsedDays: 0,
      elapsedRatio: 0,
      kind: "future",
    });
  });

  it("うるう年の2月（2024-02）は29日", () => {
    const progress = getMonthProgress("2024-02", "2024-02-10");
    expect(progress.daysInMonth).toBe(29);
    expect(progress.elapsedDays).toBe(10);
  });

  it("うるう年の2月を過去月として見ると elapsedDays が29", () => {
    const progress = getMonthProgress("2024-02", "2024-03-01");
    expect(progress.daysInMonth).toBe(29);
    expect(progress.elapsedDays).toBe(29);
    expect(progress.kind).toBe("past");
  });

  it("平年の2月（2026-02）は28日", () => {
    const progress = getMonthProgress("2026-02", "2026-02-10");
    expect(progress.daysInMonth).toBe(28);
  });

  it("年をまたいだ過去月（2025-12 を 2026-01 から見る）は elapsedDays = 31（全日）", () => {
    const progress = getMonthProgress("2025-12", "2026-01-05");
    expect(progress.kind).toBe("past");
    expect(progress.daysInMonth).toBe(31);
    expect(progress.elapsedDays).toBe(31);
  });

  it("年をまたいだ未来月（2026-01 を 2025-12 から見る）は elapsedDays = 0", () => {
    const progress = getMonthProgress("2026-01", "2025-12-20");
    expect(progress.kind).toBe("future");
    expect(progress.elapsedDays).toBe(0);
  });

  it("不正な年月は RangeError", () => {
    expect(() => getMonthProgress("invalid", "2026-08-14")).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ *
 * 目安・着地見込み（端数の向き）
 * ------------------------------------------------------------------ */

describe("calculateExpectedYen — 切り捨て", () => {
  it("380000 × 14 ÷ 31 = 171612.9… → 切り捨てて 171612円（docs/steps/step-6.md の例）", () => {
    const progress = getMonthProgress("2026-08", "2026-08-14");
    expect(calculateExpectedYen(380_000, progress)).toBe(171_612);
  });

  it("割り切れる場合はそのまま（切り捨ての向きを別途、割り切れない数で確認済み）", () => {
    // 31日中31日経過（過去月扱い）なら目安=予算そのもの
    const progress = getMonthProgress("2026-07", "2026-08-01");
    expect(calculateExpectedYen(62_000, progress)).toBe(62_000);
  });

  it("予算が未設定（null）なら null", () => {
    const progress = getMonthProgress("2026-08", "2026-08-14");
    expect(calculateExpectedYen(null, progress)).toBeNull();
  });

  it("未来月（経過日数0）は 0（null ではない）", () => {
    const progress = getMonthProgress("2026-09", "2026-08-14");
    expect(calculateExpectedYen(100_000, progress)).toBe(0);
  });

  it("予算0円なら目安も0", () => {
    const progress = getMonthProgress("2026-08", "2026-08-14");
    expect(calculateExpectedYen(0, progress)).toBe(0);
  });
});

describe("calculateProjectedYen — 切り上げ", () => {
  it("250 ÷ 14 × 31 = 553.57… → 切り上げて 554円（docs/steps/step-6.md の例）", () => {
    const progress = getMonthProgress("2026-08", "2026-08-14");
    expect(calculateProjectedYen(250, progress)).toBe(554);
  });

  it("経過0日（未来月）は null（ゼロ除算を避ける）", () => {
    const progress = getMonthProgress("2026-09", "2026-08-14");
    expect(calculateProjectedYen(1000, progress)).toBeNull();
  });

  it("実績0円なら着地見込みも0", () => {
    const progress = getMonthProgress("2026-08", "2026-08-14");
    expect(calculateProjectedYen(0, progress)).toBe(0);
  });

  it("割り切れる場合の確認（14日で7000円 → 31日で 7000/14*31=15500）", () => {
    const progress = getMonthProgress("2026-08", "2026-08-14");
    expect(calculateProjectedYen(7_000, progress)).toBe(15_500);
  });
});

/* ------------------------------------------------------------------ *
 * 消化率
 * ------------------------------------------------------------------ */

describe("calculateUsageRatio", () => {
  it("予算未設定（null）は null", () => {
    expect(calculateUsageRatio(null, 500)).toBeNull();
  });

  it("予算 > 0 は 実績 ÷ 予算", () => {
    expect(calculateUsageRatio(4_000, 1_000)).toBe(0.25);
  });

  it("予算0円・実績0円は 0", () => {
    expect(calculateUsageRatio(0, 0)).toBe(0);
  });

  it("予算0円・実績>0円は Number.POSITIVE_INFINITY（null にも0にもしない）", () => {
    expect(calculateUsageRatio(0, 1)).toBe(Number.POSITIVE_INFINITY);
  });
});

/* ------------------------------------------------------------------ *
 * ペース判定（評価順が最重要）
 * ------------------------------------------------------------------ */

describe("judgePaceStatus — 評価順", () => {
  it("予算が未設定（null）は unknown", () => {
    expect(judgePaceStatus(null, 500, 200)).toBe("unknown");
  });

  it("目安が null（防御的）でも unknown", () => {
    expect(judgePaceStatus(1000, 500, null)).toBe("unknown");
  });

  it("実績 > 予算 なら、目安より少なくても over（評価順の一番手）", () => {
    // 目安=2000 > 実績=1500 だが、予算=1000 < 実績=1500 なので over
    expect(judgePaceStatus(1_000, 1_500, 2_000)).toBe("over");
  });

  it("実績 > 目安（予算以下）でも over", () => {
    expect(judgePaceStatus(5_000, 1_200, 1_000)).toBe("over");
  });

  it("実績 === 目安 × 0.9 ちょうどは under（超えていない）", () => {
    // 目安1000・警戒ライン=900。実績=900は「超えた」に該当しない
    expect(judgePaceStatus(2_000, 900, 1_000)).toBe("under");
  });

  it("実績 が 目安 × 0.9 をわずかに超えると warning", () => {
    expect(judgePaceStatus(2_000, 901, 1_000)).toBe("warning");
  });

  it("実績 === 目安（目安>0）は、目安×0.9 を超えるため warning になる", () => {
    // 表の評価順どおりに手計算する:
    // 実績(1000) > 予算(2000)? いいえ。実績(1000) > 目安(1000)? いいえ（同値は超えていない）。
    // 実績(1000) > 目安×0.9(900)? はい → warning
    expect(judgePaceStatus(2_000, 1_000, 1_000)).toBe("warning");
  });

  it("目安が0円で実績も0円なら under（0 > 0 は成立しない）", () => {
    expect(judgePaceStatus(1_000, 0, 0)).toBe("under");
  });

  it("実績が予算を超えていなくても目安を超えていれば over（境界を跨がない通常パターン）", () => {
    expect(judgePaceStatus(10_000, 6_000, 5_000)).toBe("over");
  });
});

describe("PACE_WARNING_RATIO / PACE_STATUS_LABELS", () => {
  it("警戒ラインは 0.9", () => {
    expect(PACE_WARNING_RATIO).toBe(0.9);
  });

  it("日本語ラベルが4状態ぶん揃っている", () => {
    expect(PACE_STATUS_LABELS).toEqual({
      under: "予算内",
      warning: "要注意",
      over: "超過",
      unknown: "予算未設定",
    });
  });
});

/* ------------------------------------------------------------------ *
 * バー・符号付き表示
 * ------------------------------------------------------------------ */

describe("getUsageBarPercent", () => {
  it("null は 0", () => {
    expect(getUsageBarPercent(null)).toBe(0);
  });

  it("0 は 0", () => {
    expect(getUsageBarPercent(0)).toBe(0);
  });

  it("0〜1 の間は四捨五入（33.3% → 33、66.7% → 67）", () => {
    expect(getUsageBarPercent(1 / 3)).toBe(33);
    expect(getUsageBarPercent(2 / 3)).toBe(67);
  });

  it("1 は 100", () => {
    expect(getUsageBarPercent(1)).toBe(100);
  });

  it("1 を超えても 100 で止まる", () => {
    expect(getUsageBarPercent(1.5)).toBe(100);
  });

  it("Infinity は 100", () => {
    expect(getUsageBarPercent(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe("formatSignedYen", () => {
  it("正の金額は通常表示", () => {
    expect(formatSignedYen(1_000)).toBe("¥1,000");
  });

  it("負の金額はマイナス記号が¥の前に来る", () => {
    expect(formatSignedYen(-52_400)).toBe("-¥52,400");
  });

  it("0円はマイナス表示にならない", () => {
    expect(formatSignedYen(0)).toBe("¥0");
  });
});

/* ------------------------------------------------------------------ *
 * 払い出し先ごとの行
 * ------------------------------------------------------------------ */

function paymentSource(
  overrides: Partial<DashboardPaymentSourceInput> = {},
): DashboardPaymentSourceInput {
  return {
    id: "ps_1",
    sortOrder: 1,
    isActive: true,
    name: "現金",
    type: PaymentSourceType.CASH,
    ...overrides,
  };
}

describe("buildPaymentSourceProgressRows — 行に含める払い出し先", () => {
  const progress = getMonthProgress("2026-08", "2026-08-14");

  it("有効な払い出し先は予算も支出も無くても行が出る", () => {
    const rows = buildPaymentSourceProgressRows({
      paymentSources: [paymentSource({ id: "ps_1" })],
      budgets: [],
      expenses: [],
      progress,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      paymentSourceId: "ps_1",
      budgetYen: null,
      spentYen: 0,
      count: 0,
      remainingYen: null,
      expectedYen: null,
      usageRatio: null,
      status: "unknown",
    });
  });

  it("無効な払い出し先は予算も支出も無ければ出ない", () => {
    const rows = buildPaymentSourceProgressRows({
      paymentSources: [paymentSource({ id: "ps_1", isActive: false })],
      budgets: [],
      expenses: [],
      progress,
    });
    expect(rows).toHaveLength(0);
  });

  it("無効な払い出し先は予算だけあれば出る", () => {
    const rows = buildPaymentSourceProgressRows({
      paymentSources: [paymentSource({ id: "ps_1", isActive: false })],
      budgets: [{ paymentSourceId: "ps_1", amountYen: 5_000 }],
      expenses: [],
      progress,
    });
    expect(rows).toHaveLength(1);
  });

  it("無効な払い出し先は支出だけあれば出る", () => {
    const rows = buildPaymentSourceProgressRows({
      paymentSources: [paymentSource({ id: "ps_1", isActive: false })],
      budgets: [],
      expenses: [{ paymentSourceId: "ps_1", amountYen: 300 }],
      progress,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.spentYen).toBe(300);
  });
});

describe("buildPaymentSourceProgressRows — 並べ替え", () => {
  const progress = getMonthProgress("2026-08", "2026-08-14");

  it("予算0円で使ってしまった行が消化率の先頭に来る（Infinity が最大）", () => {
    const rows = buildPaymentSourceProgressRows({
      paymentSources: [
        paymentSource({ id: "ps_high", sortOrder: 1, name: "高消化率" }),
        paymentSource({ id: "ps_zero_budget", sortOrder: 2, name: "予算0円で使った" }),
      ],
      budgets: [
        // 高消化率: 予算500円・実績1000円 → 200%
        { paymentSourceId: "ps_high", amountYen: 500 },
        // 予算0円で使った: 予算0円・実績1円 → Infinity
        { paymentSourceId: "ps_zero_budget", amountYen: 0 },
      ],
      expenses: [
        { paymentSourceId: "ps_high", amountYen: 1_000 },
        { paymentSourceId: "ps_zero_budget", amountYen: 1 },
      ],
      progress,
    });

    // Infinity - Infinity = NaN で並びが壊れないことも同時に確認するため、
    // Infinity の行を複数用意しても先頭2件がまとまることを見る
    expect(rows.map((row) => row.paymentSourceId)).toEqual(["ps_zero_budget", "ps_high"]);
    expect(rows[0]?.usageRatio).toBe(Number.POSITIVE_INFINITY);
  });

  it("Infinity 同士でも並びが壊れない（表示順が保たれる）", () => {
    const rows = buildPaymentSourceProgressRows({
      paymentSources: [
        paymentSource({ id: "ps_a", sortOrder: 1, name: "A" }),
        paymentSource({ id: "ps_b", sortOrder: 2, name: "B" }),
      ],
      budgets: [
        { paymentSourceId: "ps_a", amountYen: 0 },
        { paymentSourceId: "ps_b", amountYen: 0 },
      ],
      expenses: [
        { paymentSourceId: "ps_a", amountYen: 100 },
        { paymentSourceId: "ps_b", amountYen: 200 },
      ],
      progress,
    });
    // どちらも Infinity。表示順（sortOrder）どおり A → B のまま
    expect(rows.map((row) => row.paymentSourceId)).toEqual(["ps_a", "ps_b"]);
  });

  it("同率のときは表示順（sortPaymentSources）が保たれる", () => {
    const rows = buildPaymentSourceProgressRows({
      paymentSources: [
        paymentSource({ id: "ps_second", sortOrder: 2, name: "後" }),
        paymentSource({ id: "ps_first", sortOrder: 1, name: "先" }),
      ],
      budgets: [
        { paymentSourceId: "ps_second", amountYen: 2_000 },
        { paymentSourceId: "ps_first", amountYen: 1_000 },
      ],
      expenses: [
        { paymentSourceId: "ps_second", amountYen: 1_000 }, // 50%
        { paymentSourceId: "ps_first", amountYen: 500 }, // 50%
      ],
      progress,
    });
    // 同率(0.5)なので sortOrder 昇順 = ps_first(1) が先
    expect(rows.map((row) => row.paymentSourceId)).toEqual(["ps_first", "ps_second"]);
  });

  it("予算未設定は消化率の値に関わらず末尾にまとめられる", () => {
    const rows = buildPaymentSourceProgressRows({
      paymentSources: [
        paymentSource({ id: "ps_unset", sortOrder: 1, name: "未設定" }),
        paymentSource({ id: "ps_zero_usage", sortOrder: 2, name: "0%使用" }),
      ],
      budgets: [{ paymentSourceId: "ps_zero_usage", amountYen: 1_000 }],
      expenses: [],
      progress,
    });
    // 予算未設定(null)は消化率0の行より後ろに来る
    expect(rows.map((row) => row.paymentSourceId)).toEqual(["ps_zero_usage", "ps_unset"]);
  });
});

describe("buildPaymentSourceProgressRows — 各フィールドの計算", () => {
  const progress = getMonthProgress("2026-08", "2026-08-14"); // 14/31日

  it("remainingYen は 予算-実績（マイナスもあり得る）", () => {
    const rows = buildPaymentSourceProgressRows({
      paymentSources: [paymentSource({ id: "ps_1" })],
      budgets: [{ paymentSourceId: "ps_1", amountYen: 1_000 }],
      expenses: [{ paymentSourceId: "ps_1", amountYen: 1_500 }],
      progress,
    });
    expect(rows[0]?.remainingYen).toBe(-500);
  });

  it("count は該当する支出の件数", () => {
    const rows = buildPaymentSourceProgressRows({
      paymentSources: [paymentSource({ id: "ps_1" })],
      budgets: [],
      expenses: [
        { paymentSourceId: "ps_1", amountYen: 100 },
        { paymentSourceId: "ps_1", amountYen: 200 },
        { paymentSourceId: "ps_other", amountYen: 999 },
      ],
      progress,
    });
    expect(rows[0]?.count).toBe(2);
    expect(rows[0]?.spentYen).toBe(300);
  });
});

/* ------------------------------------------------------------------ *
 * 全体の集計
 * ------------------------------------------------------------------ */

describe("buildDashboardSummary", () => {
  const progress = getMonthProgress("2026-08", "2026-08-14");

  it("総予算には無効な払い出し先の予算も含む", () => {
    const summary = buildDashboardSummary({
      paymentSources: [
        paymentSource({ id: "ps_active", isActive: true }),
        paymentSource({ id: "ps_inactive", isActive: false }),
      ],
      budgets: [
        { paymentSourceId: "ps_active", amountYen: 10_000 },
        { paymentSourceId: "ps_inactive", amountYen: 5_000 },
      ],
      expenses: [],
      progress,
    });
    expect(summary.totalBudgetYen).toBe(15_000);
  });

  it("総予算0円は totalStatus が unknown になる", () => {
    const summary = buildDashboardSummary({
      paymentSources: [paymentSource({ id: "ps_1" })],
      budgets: [],
      expenses: [{ paymentSourceId: "ps_1", amountYen: 500 }],
      progress,
    });
    expect(summary.totalBudgetYen).toBe(0);
    expect(summary.totalStatus).toBe("unknown");
  });

  it("総予算0円でも totalProjectedYen は式どおりの値を返す（経過日数>0なら null にしない）", () => {
    const summary = buildDashboardSummary({
      paymentSources: [paymentSource({ id: "ps_1" })],
      budgets: [],
      expenses: [{ paymentSourceId: "ps_1", amountYen: 700 }],
      progress, // 14/31日
    });
    // 700 / 14 * 31 = 1550（割り切れる）
    expect(summary.totalProjectedYen).toBe(1_550);
  });

  it("unsetBudgetCount は有効な払い出し先のうち予算未設定の件数だけを数える", () => {
    const summary = buildDashboardSummary({
      paymentSources: [
        paymentSource({ id: "ps_active_unset", isActive: true }),
        paymentSource({ id: "ps_active_set", isActive: true }),
        paymentSource({ id: "ps_inactive_unset", isActive: false }),
      ],
      budgets: [{ paymentSourceId: "ps_active_set", amountYen: 1_000 }],
      // 無効な払い出し先は支出だけ持たせて行に含める
      expenses: [{ paymentSourceId: "ps_inactive_unset", amountYen: 100 }],
      progress,
    });
    expect(summary.unsetBudgetCount).toBe(1);
  });

  it("remainingYen は総予算-総実績（マイナスもあり得る）", () => {
    const summary = buildDashboardSummary({
      paymentSources: [paymentSource({ id: "ps_1" })],
      budgets: [{ paymentSourceId: "ps_1", amountYen: 1_000 }],
      expenses: [{ paymentSourceId: "ps_1", amountYen: 1_800 }],
      progress,
    });
    expect(summary.remainingYen).toBe(-800);
  });

  it("progress をそのまま含める", () => {
    const summary = buildDashboardSummary({
      paymentSources: [],
      budgets: [],
      expenses: [],
      progress,
    });
    expect(summary.progress).toEqual(progress);
  });
});

/* ------------------------------------------------------------------ *
 * カテゴリごとの行
 * ------------------------------------------------------------------ */

function category(overrides: Partial<DashboardCategoryInput> = {}): DashboardCategoryInput {
  return {
    id: "cat_1",
    sortOrder: 1,
    isHidden: false,
    name: "食費",
    costType: CostType.VARIABLE,
    ...overrides,
  };
}

describe("buildCategoryProgressRows", () => {
  const progress = getMonthProgress("2026-08", "2026-08-14");

  it("カテゴリ予算が設定されているカテゴリだけが出る", () => {
    const rows = buildCategoryProgressRows({
      categories: [
        category({ id: "cat_with_budget" }),
        category({ id: "cat_without_budget" }),
      ],
      categoryBudgets: [{ categoryId: "cat_with_budget", amountYen: 20_000 }],
      expenses: [],
      progress,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.categoryId).toBe("cat_with_budget");
    expect(rows[0]?.budgetYen).toBe(20_000);
  });

  it("非表示カテゴリでも予算があれば出る", () => {
    const rows = buildCategoryProgressRows({
      categories: [category({ id: "cat_hidden", isHidden: true })],
      categoryBudgets: [{ categoryId: "cat_hidden", amountYen: 3_000 }],
      expenses: [],
      progress,
    });
    expect(rows).toHaveLength(1);
  });

  it("並びは消化率の降順、同率は表示順", () => {
    const rows = buildCategoryProgressRows({
      categories: [
        category({ id: "cat_low", sortOrder: 1, name: "低" }),
        category({ id: "cat_high", sortOrder: 2, name: "高" }),
      ],
      categoryBudgets: [
        { categoryId: "cat_low", amountYen: 10_000 },
        { categoryId: "cat_high", amountYen: 1_000 },
      ],
      expenses: [
        { categoryId: "cat_low", amountYen: 1_000 }, // 10%
        { categoryId: "cat_high", amountYen: 900 }, // 90%
      ],
      progress,
    });
    expect(rows.map((row) => row.categoryId)).toEqual(["cat_high", "cat_low"]);
  });

  it("カテゴリの合計（budgetYen の合計）は総予算とは別で、集計側で足されることはない", () => {
    // buildCategoryProgressRows の入力型には Budget（払い出し先予算）が無いため、
    // 型の上で総予算と混ざりようがない。ここでは budgetYen が渡した CategoryBudget の値と
    // 一致し、支出の合計と別物であることだけを確認する
    const rows = buildCategoryProgressRows({
      categories: [category({ id: "cat_1" })],
      categoryBudgets: [{ categoryId: "cat_1", amountYen: 50_000 }],
      expenses: [{ categoryId: "cat_1", amountYen: 1_000 }],
      progress,
    });
    expect(rows[0]?.budgetYen).toBe(50_000);
    expect(rows[0]?.remainingYen).toBe(49_000);
  });
});

/* ------------------------------------------------------------------ *
 * 収入と収支
 * ------------------------------------------------------------------ */

describe("summarizeIncomes", () => {
  it("0件でも枠は出す（合計0・件数0）", () => {
    expect(summarizeIncomes("2026-08", [])).toEqual({
      yearMonth: "2026-08",
      totalYen: 0,
      count: 0,
    });
  });

  it("複数件の合計と件数", () => {
    expect(
      summarizeIncomes("2026-08", [{ amountYen: 300_000 }, { amountYen: 50_000 }]),
    ).toEqual({ yearMonth: "2026-08", totalYen: 350_000, count: 2 });
  });
});

describe("buildIncomeBalance", () => {
  it("前月の収入が0件なら null（画面は枠ごと出さない）", () => {
    expect(buildIncomeBalance("2026-08", [], 100_000)).toBeNull();
  });

  it("扱える範囲の先頭（0000-01）でも0件なら例外を投げない（空判定が先）", () => {
    expect(buildIncomeBalance("0000-01", [], 0)).toBeNull();
  });

  it("0000-01 で0件でない場合は previousYearMonth が範囲外で RangeError", () => {
    expect(() => buildIncomeBalance("0000-01", [{ amountYen: 1_000 }], 0)).toThrow(RangeError);
  });

  it("docs/steps/step-6.md の見本どおりの数値（収入420,000円・支出227,600円 → 差額192,400円）", () => {
    const balance = buildIncomeBalance("2026-08", [{ amountYen: 420_000 }], 227_600);
    expect(balance).toEqual({
      incomeYearMonth: "2026-07",
      incomeTotalYen: 420_000,
      spentYen: 227_600,
      balanceYen: 192_400,
    });
  });

  it("差額がマイナスになる場合もそのまま返す", () => {
    const balance = buildIncomeBalance("2026-08", [{ amountYen: 100_000 }], 150_000);
    expect(balance?.balanceYen).toBe(-50_000);
  });

  it("前月の収入が複数件なら合計する（sumAmounts を使う）", () => {
    const balance = buildIncomeBalance(
      "2026-08",
      [{ amountYen: 300_000 }, { amountYen: 20_000 }],
      0,
    );
    expect(balance?.incomeTotalYen).toBe(320_000);
  });

  it("収支の月は表示中の月の前月そのもの", () => {
    const balance = buildIncomeBalance("2026-01", [{ amountYen: 1_000 }], 0);
    expect(balance?.incomeYearMonth).toBe("2025-12");
  });
});
