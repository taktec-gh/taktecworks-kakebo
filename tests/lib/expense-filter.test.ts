// @vitest-environment node
//
// src/lib/expense-filter.ts の URL クエリ ⇔ 絞り込み条件の変換（純粋関数）を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > 一覧は月単位。絞り込みと並べ替えは URL に持つ」
//   「月は /budgets と同じ ?month=YYYY-MM。不正値・未指定は今月（JST）」
//   「並べ替えは日付の新しい順（既定）と金額の高い順」
// - docs/steps/step-5.md「実装完了後の引き継ぎ > 特に確認したい観点」10.
//   「配列パラメータ・空文字・不正値がすべて既定へ落ちること」
//   「parse → build → parse が同じ結果になること」

import { describe, expect, it } from "vitest";

import { WasteTag } from "@/generated/prisma/enums";
import { getCurrentYearMonth } from "@/lib/year-month";
import {
  buildExpenseListQuery,
  clearExpenseFilter,
  DEFAULT_EXPENSE_SORT,
  EXPENSE_FILTER_PARAMS,
  hasActiveExpenseFilter,
  isExpenseSortKey,
  parseExpenseListFilter,
  withExpenseFilter,
  type ExpenseListFilter,
} from "@/lib/expense-filter";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const CURRENT_YM = getCurrentYearMonth(NOW); // "2026-08"

describe("isExpenseSortKey", () => {
  it("'date' / 'amount' は true", () => {
    expect(isExpenseSortKey("date")).toBe(true);
    expect(isExpenseSortKey("amount")).toBe(true);
  });

  it("それ以外は false", () => {
    expect(isExpenseSortKey("invalid")).toBe(false);
    expect(isExpenseSortKey(undefined)).toBe(false);
  });
});

describe("parseExpenseListFilter — 既定値への落とし込み", () => {
  it("すべて未指定なら今月・絞り込みなし・日付順になる", () => {
    expect(parseExpenseListFilter({}, NOW)).toEqual({
      yearMonth: CURRENT_YM,
      categoryId: null,
      paymentSourceId: null,
      wasteTag: null,
      sort: "date",
    });
  });

  it("month が不正な形式なら今月（JST）に落ちる", () => {
    const filter = parseExpenseListFilter({ month: "not-a-month" }, NOW);
    expect(filter.yearMonth).toBe(CURRENT_YM);
  });

  it("month が配列（?month=a&month=b）なら未指定扱いで今月に落ちる", () => {
    const filter = parseExpenseListFilter({ month: ["2026-01", "2026-02"] }, NOW);
    expect(filter.yearMonth).toBe(CURRENT_YM);
  });

  it("category / paymentSource が空文字なら絞り込みなし（null）", () => {
    const filter = parseExpenseListFilter({ category: "", paymentSource: "" }, NOW);
    expect(filter.categoryId).toBeNull();
    expect(filter.paymentSourceId).toBeNull();
  });

  it("category / paymentSource が配列なら絞り込みなし（null）", () => {
    const filter = parseExpenseListFilter(
      { category: ["a", "b"], paymentSource: ["c", "d"] },
      NOW,
    );
    expect(filter.categoryId).toBeNull();
    expect(filter.paymentSourceId).toBeNull();
  });

  it("category / paymentSource の前後空白は trim される", () => {
    const filter = parseExpenseListFilter({ category: "  cat_1  " }, NOW);
    expect(filter.categoryId).toBe("cat_1");
  });

  it("waste が不正な値なら絞り込みなし（null）", () => {
    const filter = parseExpenseListFilter({ waste: "invalid" }, NOW);
    expect(filter.wasteTag).toBeNull();
  });

  it("waste が正しい値ならそのまま反映する", () => {
    const filter = parseExpenseListFilter({ waste: WasteTag.WASTE }, NOW);
    expect(filter.wasteTag).toBe(WasteTag.WASTE);
  });

  it("sort が不正・未指定なら既定（date）に落ちる", () => {
    expect(parseExpenseListFilter({ sort: "invalid" }, NOW).sort).toBe("date");
    expect(parseExpenseListFilter({}, NOW).sort).toBe("date");
  });

  it("sort が 'amount' ならそのまま反映する", () => {
    expect(parseExpenseListFilter({ sort: "amount" }, NOW).sort).toBe("amount");
  });

  it("正しい指定はすべて反映する", () => {
    const filter = parseExpenseListFilter(
      {
        month: "2026-05",
        category: "cat_1",
        paymentSource: "ps_1",
        waste: WasteTag.INVESTMENT,
        sort: "amount",
      },
      NOW,
    );
    expect(filter).toEqual({
      yearMonth: "2026-05",
      categoryId: "cat_1",
      paymentSourceId: "ps_1",
      wasteTag: WasteTag.INVESTMENT,
      sort: "amount",
    });
  });
});

describe("withExpenseFilter", () => {
  it("一部だけ差し替える。元のオブジェクトは変更しない", () => {
    const base: ExpenseListFilter = {
      yearMonth: "2026-08",
      categoryId: null,
      paymentSourceId: null,
      wasteTag: null,
      sort: "date",
    };
    const updated = withExpenseFilter(base, { yearMonth: "2026-09" });
    expect(updated.yearMonth).toBe("2026-09");
    expect(base.yearMonth).toBe("2026-08"); // 元は変わらない
  });
});

describe("hasActiveExpenseFilter", () => {
  const base: ExpenseListFilter = {
    yearMonth: "2026-08",
    categoryId: null,
    paymentSourceId: null,
    wasteTag: null,
    sort: "date",
  };

  it("絞り込みが無ければ false（月・並べ替えだけでは絞り込み扱いしない）", () => {
    expect(hasActiveExpenseFilter(base)).toBe(false);
    expect(hasActiveExpenseFilter({ ...base, sort: "amount" })).toBe(false);
  });

  it("categoryId / paymentSourceId / wasteTag のいずれかがあれば true", () => {
    expect(hasActiveExpenseFilter({ ...base, categoryId: "cat_1" })).toBe(true);
    expect(hasActiveExpenseFilter({ ...base, paymentSourceId: "ps_1" })).toBe(true);
    expect(hasActiveExpenseFilter({ ...base, wasteTag: WasteTag.WASTE })).toBe(true);
  });
});

describe("clearExpenseFilter", () => {
  it("月と並べ替えは残し、絞り込みだけ解除する", () => {
    const filter: ExpenseListFilter = {
      yearMonth: "2026-08",
      categoryId: "cat_1",
      paymentSourceId: "ps_1",
      wasteTag: WasteTag.WASTE,
      sort: "amount",
    };
    expect(clearExpenseFilter(filter)).toEqual({
      yearMonth: "2026-08",
      categoryId: null,
      paymentSourceId: null,
      wasteTag: null,
      sort: "amount",
    });
  });
});

describe("buildExpenseListQuery", () => {
  it("既定値（絞り込みなし・日付順）は month 以外を省く", () => {
    const filter: ExpenseListFilter = {
      yearMonth: "2026-08",
      categoryId: null,
      paymentSourceId: null,
      wasteTag: null,
      sort: DEFAULT_EXPENSE_SORT,
    };
    expect(buildExpenseListQuery(filter)).toBe(
      new URLSearchParams({ [EXPENSE_FILTER_PARAMS.month]: "2026-08" }).toString(),
    );
  });

  it("絞り込み・並べ替えがあればすべてクエリに含める", () => {
    const filter: ExpenseListFilter = {
      yearMonth: "2026-08",
      categoryId: "cat_1",
      paymentSourceId: "ps_1",
      wasteTag: WasteTag.WASTE,
      sort: "amount",
    };
    const query = buildExpenseListQuery(filter);
    const parsed = new URLSearchParams(query);
    expect(parsed.get(EXPENSE_FILTER_PARAMS.month)).toBe("2026-08");
    expect(parsed.get(EXPENSE_FILTER_PARAMS.category)).toBe("cat_1");
    expect(parsed.get(EXPENSE_FILTER_PARAMS.paymentSource)).toBe("ps_1");
    expect(parsed.get(EXPENSE_FILTER_PARAMS.waste)).toBe(WasteTag.WASTE);
    expect(parsed.get(EXPENSE_FILTER_PARAMS.sort)).toBe("amount");
  });
});

describe("parse → build → parse の往復が同じ結果になること", () => {
  it("絞り込みありのケース", () => {
    const original = parseExpenseListFilter(
      {
        month: "2026-05",
        category: "cat_1",
        paymentSource: "ps_1",
        waste: WasteTag.WASTE,
        sort: "amount",
      },
      NOW,
    );
    const query = buildExpenseListQuery(original);
    const params = Object.fromEntries(new URLSearchParams(query));
    const roundTripped = parseExpenseListFilter(params, NOW);
    expect(roundTripped).toEqual(original);
  });

  it("絞り込みなし・既定値のケース", () => {
    const original = parseExpenseListFilter({}, NOW);
    const query = buildExpenseListQuery(original);
    const params = Object.fromEntries(new URLSearchParams(query));
    const roundTripped = parseExpenseListFilter(params, NOW);
    expect(roundTripped).toEqual(original);
  });
});
