// @vitest-environment node
//
// src/lib/ordering.ts の汎用並べ替えロジック（createOrdering）を検証する。
// DB非依存の純粋関数なのでモックは不要。
//
// 期待値の根拠:
// - docs/steps/step-4.md「設計判断 > 並べ替えロジックは共通化する」
//   「先に表示するグループ → 後のグループの順」「移動は同一グループ内のみ」
//   「sortOrder は隙間を作らず 1 からの連番を保つ」
// - docs/steps/step-3.md「設計判断」（払い出し先で確立した規則がそのまま汎用モジュールの仕様になる）
//
// tests/lib/payment-source-order.test.ts と同じ観点を、抽象化されたフラグ
// （ここでは「primary」）で検証する。払い出し先・カテゴリそれぞれの薄い層の検証は
// tests/lib/payment-source-order.test.ts / tests/lib/category-order.test.ts が担当し、
// 両者が同じ規則で動くことは本ファイル末尾の「共通化の退行検出」で確認する。

import { describe, expect, it } from "vitest";

import {
  createOrdering,
  isMoveDirection,
  type OrderItem,
  type OrderErrorMessages,
} from "@/lib/ordering";

type Item = OrderItem & { primary: boolean };

const ERRORS: OrderErrorMessages = {
  notFound: "見つかりません",
  cannotMoveUp: "上へ移動できません",
  cannotMoveDown: "下へ移動できません",
  invalidDirection: "方向が不正です",
};

const ordering = createOrdering<Item>({
  isPrimaryGroup: (item) => item.primary,
  errors: ERRORS,
});

/** primary 3件（sortOrder 1..3）+ 非primary 2件（sortOrder 4..5）。整列済みの基本形 */
function basicList(): Item[] {
  return [
    { id: "a1", sortOrder: 1, primary: true },
    { id: "a2", sortOrder: 2, primary: true },
    { id: "a3", sortOrder: 3, primary: true },
    { id: "b1", sortOrder: 4, primary: false },
    { id: "b2", sortOrder: 5, primary: false },
  ];
}

describe("isMoveDirection", () => {
  it.each(["up", "down"])("%s は正しい方向", (value) => {
    expect(isMoveDirection(value)).toBe(true);
  });

  it.each(["left", "", "UP", null, undefined, 1])("%s は不正な方向", (value) => {
    expect(isMoveDirection(value)).toBe(false);
  });
});

describe("errors はオプションで渡した文言をそのまま公開する", () => {
  it("createOrdering の戻り値の errors がオプションと同一である", () => {
    expect(ordering.errors).toBe(ERRORS);
  });
});

describe("compare / sort", () => {
  it("primary グループが非 primary グループより常に先に来る", () => {
    const list: Item[] = [
      { id: "low-sort-non-primary", sortOrder: 1, primary: false },
      { id: "high-sort-primary", sortOrder: 99, primary: true },
    ];
    expect(ordering.sort(list).map((i) => i.id)).toEqual([
      "high-sort-primary",
      "low-sort-non-primary",
    ]);
  });

  it("同じグループ内は sortOrder 昇順", () => {
    expect(ordering.sort(basicList()).map((i) => i.id)).toEqual([
      "a1",
      "a2",
      "a3",
      "b1",
      "b2",
    ]);
  });

  it("primary・sortOrder が同値なら id 昇順で確定する（入力順に依らない）", () => {
    const list: Item[] = [
      { id: "z", sortOrder: 1, primary: true },
      { id: "a", sortOrder: 1, primary: true },
      { id: "m", sortOrder: 1, primary: true },
    ];
    expect(ordering.sort(list).map((i) => i.id)).toEqual(["a", "m", "z"]);
  });

  it("sort は引数の配列を破壊しない", () => {
    const list = basicList();
    const before = JSON.parse(JSON.stringify(list));
    ordering.sort(list);
    expect(list).toEqual(before);
  });

  it("compare 単体でも同じ規則で比較できる", () => {
    const primary: Item = { id: "a", sortOrder: 5, primary: true };
    const nonPrimary: Item = { id: "b", sortOrder: 1, primary: false };
    expect(ordering.compare(primary, nonPrimary)).toBeLessThan(0);
    expect(ordering.compare(nonPrimary, primary)).toBeGreaterThan(0);
    expect(ordering.compare(primary, primary)).toBe(0);
  });
});

describe("assignSequentialSortOrder", () => {
  it("表示順のまま1からの連番を割り当てる", () => {
    expect(ordering.assignSequentialSortOrder(basicList())).toEqual([
      { id: "a1", sortOrder: 1 },
      { id: "a2", sortOrder: 2 },
      { id: "a3", sortOrder: 3 },
      { id: "b1", sortOrder: 4 },
      { id: "b2", sortOrder: 5 },
    ]);
  });

  it("欠番・重複があっても表示順に基づいた1..nの連番になる", () => {
    const list: Item[] = [
      { id: "z", sortOrder: 500, primary: true },
      { id: "x", sortOrder: 10, primary: true },
      { id: "y", sortOrder: 10, primary: true },
    ];
    expect(ordering.assignSequentialSortOrder(list)).toEqual([
      { id: "x", sortOrder: 1 },
      { id: "y", sortOrder: 2 },
      { id: "z", sortOrder: 3 },
    ]);
  });

  it("空配列は空配列を返す", () => {
    expect(ordering.assignSequentialSortOrder([])).toEqual([]);
  });

  it("引数の配列を破壊しない", () => {
    const list = basicList();
    const before = JSON.parse(JSON.stringify(list));
    ordering.assignSequentialSortOrder(list);
    expect(list).toEqual(before);
  });
});

describe("canMove — グループ境界", () => {
  it("primary グループの先頭は上へ移動できない", () => {
    expect(ordering.canMove(basicList(), "a1", "up")).toBe(false);
  });

  it("primary グループの末尾は下へ移動できない（非 primary グループへ飛び越さない）", () => {
    expect(ordering.canMove(basicList(), "a3", "down")).toBe(false);
  });

  it("非 primary グループの先頭は上へ移動できない（primary グループへ飛び越さない）", () => {
    expect(ordering.canMove(basicList(), "b1", "up")).toBe(false);
  });

  it("非 primary グループの末尾（＝一覧の末尾）は下へ移動できない", () => {
    expect(ordering.canMove(basicList(), "b2", "down")).toBe(false);
  });

  it("primary グループの中間は上下どちらにも移動できる", () => {
    expect(ordering.canMove(basicList(), "a2", "up")).toBe(true);
    expect(ordering.canMove(basicList(), "a2", "down")).toBe(true);
  });

  it("非 primary グループ内の移動（先頭以外を上へ、末尾以外を下へ）はできる", () => {
    expect(ordering.canMove(basicList(), "b2", "up")).toBe(true);
    expect(ordering.canMove(basicList(), "b1", "down")).toBe(true);
  });

  it("一覧に存在しない id は false", () => {
    expect(ordering.canMove(basicList(), "no-such-id", "up")).toBe(false);
  });

  it("primary グループが1件だけなら上下どちらにも移動できない", () => {
    const list: Item[] = [{ id: "only", sortOrder: 1, primary: true }];
    expect(ordering.canMove(list, "only", "up")).toBe(false);
    expect(ordering.canMove(list, "only", "down")).toBe(false);
  });

  it("空の一覧は false", () => {
    expect(ordering.canMove([], "a1", "up")).toBe(false);
  });
});

describe("calculateReorder", () => {
  it("同一グループ内の隣接スワップは全件の sortOrder を 1..n に振り直す", () => {
    expect(ordering.calculateReorder(basicList(), "a1", "down")).toEqual({
      ok: true,
      assignments: [
        { id: "a2", sortOrder: 1 },
        { id: "a1", sortOrder: 2 },
        { id: "a3", sortOrder: 3 },
        { id: "b1", sortOrder: 4 },
        { id: "b2", sortOrder: 5 },
      ],
    });
  });

  it("非 primary グループ内の移動は非 primary グループの中だけを入れ替え、primary グループは変えない", () => {
    expect(ordering.calculateReorder(basicList(), "b1", "down")).toEqual({
      ok: true,
      assignments: [
        { id: "a1", sortOrder: 1 },
        { id: "a2", sortOrder: 2 },
        { id: "a3", sortOrder: 3 },
        { id: "b2", sortOrder: 4 },
        { id: "b1", sortOrder: 5 },
      ],
    });
  });

  it("primary グループ末尾を下へ動かそうとすると拒否される（非 primary グループへ飛び越さない）", () => {
    expect(ordering.calculateReorder(basicList(), "a3", "down")).toEqual({
      ok: false,
      error: ERRORS.cannotMoveDown,
    });
  });

  it("非 primary グループ先頭を上へ動かそうとすると拒否される（primary グループへ飛び越さない）", () => {
    expect(ordering.calculateReorder(basicList(), "b1", "up")).toEqual({
      ok: false,
      error: ERRORS.cannotMoveUp,
    });
  });

  it("一覧の先頭を上へ動かそうとすると拒否される", () => {
    expect(ordering.calculateReorder(basicList(), "a1", "up")).toEqual({
      ok: false,
      error: ERRORS.cannotMoveUp,
    });
  });

  it("一覧の末尾を下へ動かそうとすると拒否される", () => {
    expect(ordering.calculateReorder(basicList(), "b2", "down")).toEqual({
      ok: false,
      error: ERRORS.cannotMoveDown,
    });
  });

  it("存在しない id は notFound", () => {
    expect(ordering.calculateReorder(basicList(), "no-such-id", "up")).toEqual({
      ok: false,
      error: ERRORS.notFound,
    });
  });

  it("不正な方向は invalidDirection", () => {
    expect(ordering.calculateReorder(basicList(), "a1", "sideways" as never)).toEqual({
      ok: false,
      error: ERRORS.invalidDirection,
    });
  });

  it("空の一覧では notFound", () => {
    expect(ordering.calculateReorder([], "a1", "up")).toEqual({
      ok: false,
      error: ERRORS.notFound,
    });
  });

  it("未ソート・欠番・重複のある一覧を渡しても結果は 1..n の連番になる", () => {
    const list: Item[] = [
      { id: "z", sortOrder: 500, primary: true },
      { id: "x", sortOrder: 10, primary: true },
      { id: "y", sortOrder: 10, primary: true },
    ];
    // 表示順: x, y, z（同値は id 昇順） → z を上へ動かすと y と入れ替わる
    expect(ordering.calculateReorder(list, "z", "up")).toEqual({
      ok: true,
      assignments: [
        { id: "x", sortOrder: 1 },
        { id: "z", sortOrder: 2 },
        { id: "y", sortOrder: 3 },
      ],
    });
  });

  it("引数の配列を破壊しない", () => {
    const list = basicList();
    const before = JSON.parse(JSON.stringify(list));
    ordering.calculateReorder(list, "a1", "down");
    expect(list).toEqual(before);
  });
});

describe("canMove と calculateReorder の可否判断が常に一致する", () => {
  const list = basicList();
  const cases: Array<[string, "up" | "down"]> = [
    ["a1", "up"],
    ["a1", "down"],
    ["a2", "up"],
    ["a2", "down"],
    ["a3", "up"],
    ["a3", "down"],
    ["b1", "up"],
    ["b1", "down"],
    ["b2", "up"],
    ["b2", "down"],
  ];

  it.each(cases)("%s を %s へ", (id, direction) => {
    const can = ordering.canMove(list, id, direction);
    const result = ordering.calculateReorder(list, id, direction);
    expect(result.ok).toBe(can);
  });
});

// --------------------------------------------------------------------------
// 払い出し先とカテゴリが同じ規則で動くこと（共通化の退行検出）
//
// docs/steps/step-4.md「実装完了後の引き継ぎ > 特に確認したい観点」7.
// 「ordering.ts のグループ境界と、払い出し先とカテゴリが同じ規則で動くこと。
//  共通化が片方だけ壊れていないことを両方で確かめる」
//
// 払い出し先は isActive、カテゴリは !isHidden が「先に表示するグループ」。
// 同じ sortOrder/id の構成で isActive と !isHidden を対応させれば、
// 両モジュールの並び・移動可否・再割り当ての結果は完全に一致するはず。
// 一致しなければ、どちらか一方だけがグループ判定を書き換えられた（退行した）ことを示す。
// --------------------------------------------------------------------------
describe("払い出し先とカテゴリが同じ規則で動く（共通化の退行検出）", () => {
  it("sortPaymentSources と sortCategories は同じ並び順になる", async () => {
    const { sortPaymentSources } = await import("@/lib/payment-source-order");
    const { sortCategories } = await import("@/lib/category-order");

    const paymentSources = [
      { id: "b2", sortOrder: 5, isActive: false },
      { id: "a2", sortOrder: 2, isActive: true },
      { id: "b1", sortOrder: 4, isActive: false },
      { id: "a1", sortOrder: 1, isActive: true },
    ];
    // isActive: true/false ⇔ isHidden: false/true（意味が反転する点に注意）
    const categories = paymentSources.map((s) => ({
      id: s.id,
      sortOrder: s.sortOrder,
      isHidden: !s.isActive,
    }));

    const sortedSources = sortPaymentSources(paymentSources).map((s) => s.id);
    const sortedCategories = sortCategories(categories).map((c) => c.id);

    expect(sortedCategories).toEqual(sortedSources);
    expect(sortedSources).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("canMovePaymentSource と canMoveCategory は同じ構成に対して同じ可否を返す", async () => {
    const { canMovePaymentSource } = await import("@/lib/payment-source-order");
    const { canMoveCategory } = await import("@/lib/category-order");

    const paymentSources = [
      { id: "a1", sortOrder: 1, isActive: true },
      { id: "a2", sortOrder: 2, isActive: true },
      { id: "a3", sortOrder: 3, isActive: true },
      { id: "b1", sortOrder: 4, isActive: false },
      { id: "b2", sortOrder: 5, isActive: false },
    ];
    const categories = paymentSources.map((s) => ({
      id: s.id,
      sortOrder: s.sortOrder,
      isHidden: !s.isActive,
    }));

    const cases: Array<[string, "up" | "down"]> = [
      ["a1", "up"],
      ["a1", "down"],
      ["a3", "down"],
      ["b1", "up"],
      ["b1", "down"],
      ["b2", "down"],
    ];

    for (const [id, direction] of cases) {
      expect(canMoveCategory(categories, id, direction)).toBe(
        canMovePaymentSource(paymentSources, id, direction),
      );
    }
  });

  it("calculateReorder と calculateCategoryReorder は同じ構成に対して同じ assignments（id と sortOrder）を返す", async () => {
    const { calculateReorder } = await import("@/lib/payment-source-order");
    const { calculateCategoryReorder } = await import("@/lib/category-order");

    const paymentSources = [
      { id: "a1", sortOrder: 1, isActive: true },
      { id: "a2", sortOrder: 2, isActive: true },
      { id: "b1", sortOrder: 3, isActive: false },
      { id: "b2", sortOrder: 4, isActive: false },
    ];
    const categories = paymentSources.map((s) => ({
      id: s.id,
      sortOrder: s.sortOrder,
      isHidden: !s.isActive,
    }));

    const sourceResult = calculateReorder(paymentSources, "a1", "down");
    const categoryResult = calculateCategoryReorder(categories, "a1", "down");

    expect(sourceResult.ok).toBe(true);
    expect(categoryResult.ok).toBe(true);
    if (sourceResult.ok && categoryResult.ok) {
      expect(categoryResult.assignments).toEqual(sourceResult.assignments);
    }
  });

  it("グループの端での拒否（ok: false）も両モジュールで一致する", async () => {
    const { calculateReorder } = await import("@/lib/payment-source-order");
    const { calculateCategoryReorder } = await import("@/lib/category-order");

    const paymentSources = [
      { id: "a1", sortOrder: 1, isActive: true },
      { id: "b1", sortOrder: 2, isActive: false },
    ];
    const categories = paymentSources.map((s) => ({
      id: s.id,
      sortOrder: s.sortOrder,
      isHidden: !s.isActive,
    }));

    // 有効(表示)グループの末尾を下へ、無効(非表示)グループの先頭を上へ、どちらも拒否されるはず
    expect(calculateReorder(paymentSources, "a1", "down").ok).toBe(false);
    expect(calculateCategoryReorder(categories, "a1", "down").ok).toBe(false);
    expect(calculateReorder(paymentSources, "b1", "up").ok).toBe(false);
    expect(calculateCategoryReorder(categories, "b1", "up").ok).toBe(false);
  });
});
