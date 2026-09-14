// @vitest-environment node
//
// src/lib/payment-source-order.ts の並べ替え計算（純粋関数）を検証する。
// DB非依存なのでモックは不要（docs/steps/step-3.md「並べ替えの計算は純粋関数に切り出す」）。
//
// 表示順の仕様（docs/steps/step-3.md「設計判断」）:
// - 一覧は「有効」グループ → 「無効」グループの順、各グループ内は sortOrder 昇順
// - 移動は同一グループ内でのみ。グループの端では拒否
// - sortOrder は隙間を作らず連番を保つ（並べ替え結果は常に全件 1..n）

import { describe, expect, it } from "vitest";

import {
  assignSequentialSortOrder,
  calculateReorder,
  canMovePaymentSource,
  comparePaymentSourceOrder,
  isMoveDirection,
  PAYMENT_SOURCE_ORDER_ERRORS,
  sortPaymentSources,
  type PaymentSourceOrderItem,
} from "@/lib/payment-source-order";

/** 有効3件（sortOrder 1..3）+ 無効2件（sortOrder 4..5）。すでに整列済みの基本形 */
function basicList(): PaymentSourceOrderItem[] {
  return [
    { id: "a1", sortOrder: 1, isActive: true },
    { id: "a2", sortOrder: 2, isActive: true },
    { id: "a3", sortOrder: 3, isActive: true },
    { id: "b1", sortOrder: 4, isActive: false },
    { id: "b2", sortOrder: 5, isActive: false },
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

describe("comparePaymentSourceOrder / sortPaymentSources", () => {
  it("有効グループが無効グループより常に先に来る", () => {
    const list: PaymentSourceOrderItem[] = [
      { id: "inactive-low-sort", sortOrder: 1, isActive: false },
      { id: "active-high-sort", sortOrder: 99, isActive: true },
    ];
    const sorted = sortPaymentSources(list);
    expect(sorted.map((s) => s.id)).toEqual(["active-high-sort", "inactive-low-sort"]);
  });

  it("同じグループ内は sortOrder 昇順", () => {
    const sorted = sortPaymentSources(basicList());
    expect(sorted.map((s) => s.id)).toEqual(["a1", "a2", "a3", "b1", "b2"]);
  });

  it("isActive・sortOrder が同値なら id 昇順で確定する（入力順に依らない）", () => {
    const list: PaymentSourceOrderItem[] = [
      { id: "z", sortOrder: 1, isActive: true },
      { id: "a", sortOrder: 1, isActive: true },
      { id: "m", sortOrder: 1, isActive: true },
    ];
    expect(sortPaymentSources(list).map((s) => s.id)).toEqual(["a", "m", "z"]);
  });

  it("sortPaymentSources は引数の配列を破壊しない", () => {
    const list = basicList();
    const before = JSON.parse(JSON.stringify(list));
    sortPaymentSources(list);
    expect(list).toEqual(before);
  });

  it("comparePaymentSourceOrder 単体でも同じ規則で比較できる", () => {
    const active: PaymentSourceOrderItem = { id: "a", sortOrder: 5, isActive: true };
    const inactive: PaymentSourceOrderItem = { id: "b", sortOrder: 1, isActive: false };
    expect(comparePaymentSourceOrder(active, inactive)).toBeLessThan(0);
    expect(comparePaymentSourceOrder(inactive, active)).toBeGreaterThan(0);
    expect(comparePaymentSourceOrder(active, active)).toBe(0);
  });
});

describe("assignSequentialSortOrder", () => {
  it("表示順のまま1からの連番を割り当てる", () => {
    const result = assignSequentialSortOrder(basicList());
    expect(result).toEqual([
      { id: "a1", sortOrder: 1 },
      { id: "a2", sortOrder: 2 },
      { id: "a3", sortOrder: 3 },
      { id: "b1", sortOrder: 4 },
      { id: "b2", sortOrder: 5 },
    ]);
  });

  it("欠番・重複があっても表示順に基づいた1..nの連番になる", () => {
    // 未ソート・重複(10)・大きな欠番(500)を混ぜる。表示順は isActive→sortOrder→id
    const list: PaymentSourceOrderItem[] = [
      { id: "z", sortOrder: 500, isActive: true },
      { id: "x", sortOrder: 10, isActive: true },
      { id: "y", sortOrder: 10, isActive: true }, // x と同値 → id 昇順で x が先
    ];
    // 表示順: x(10), y(10, id後), z(500) → 連番 1,2,3
    expect(assignSequentialSortOrder(list)).toEqual([
      { id: "x", sortOrder: 1 },
      { id: "y", sortOrder: 2 },
      { id: "z", sortOrder: 3 },
    ]);
  });

  it("空配列は空配列を返す", () => {
    expect(assignSequentialSortOrder([])).toEqual([]);
  });

  it("引数の配列を破壊しない", () => {
    const list = basicList();
    const before = JSON.parse(JSON.stringify(list));
    assignSequentialSortOrder(list);
    expect(list).toEqual(before);
  });
});

describe("canMovePaymentSource — グループ境界", () => {
  it("有効グループの先頭は上へ移動できない", () => {
    expect(canMovePaymentSource(basicList(), "a1", "up")).toBe(false);
  });

  it("有効グループの末尾は下へ移動できない（無効グループへ飛び越さない）", () => {
    expect(canMovePaymentSource(basicList(), "a3", "down")).toBe(false);
  });

  it("無効グループの先頭は上へ移動できない（有効グループへ飛び越さない）", () => {
    expect(canMovePaymentSource(basicList(), "b1", "up")).toBe(false);
  });

  it("無効グループの末尾（＝一覧の末尾）は下へ移動できない", () => {
    expect(canMovePaymentSource(basicList(), "b2", "down")).toBe(false);
  });

  it("有効グループの中間は上下どちらにも移動できる", () => {
    expect(canMovePaymentSource(basicList(), "a2", "up")).toBe(true);
    expect(canMovePaymentSource(basicList(), "a2", "down")).toBe(true);
  });

  it("無効グループ内の移動（先頭以外を上へ、末尾以外を下へ）はできる", () => {
    expect(canMovePaymentSource(basicList(), "b2", "up")).toBe(true);
    expect(canMovePaymentSource(basicList(), "b1", "down")).toBe(true);
  });

  it("一覧に存在しない id は false", () => {
    expect(canMovePaymentSource(basicList(), "no-such-id", "up")).toBe(false);
  });

  it("有効グループが1件だけなら上下どちらにも移動できない", () => {
    const list: PaymentSourceOrderItem[] = [{ id: "only", sortOrder: 1, isActive: true }];
    expect(canMovePaymentSource(list, "only", "up")).toBe(false);
    expect(canMovePaymentSource(list, "only", "down")).toBe(false);
  });

  it("空の一覧は false", () => {
    expect(canMovePaymentSource([], "a1", "up")).toBe(false);
  });
});

describe("calculateReorder", () => {
  it("同一グループ内の隣接スワップは全件の sortOrder を 1..n に振り直す", () => {
    const result = calculateReorder(basicList(), "a1", "down");
    expect(result).toEqual({
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

  it("無効グループ内の移動は無効グループの中だけを入れ替え、有効グループは変えない", () => {
    const result = calculateReorder(basicList(), "b1", "down");
    expect(result).toEqual({
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

  it("有効グループ末尾を下へ動かそうとすると拒否される（無効グループへ飛び越さない）", () => {
    expect(calculateReorder(basicList(), "a3", "down")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ORDER_ERRORS.cannotMoveDown,
    });
  });

  it("無効グループ先頭を上へ動かそうとすると拒否される（有効グループへ飛び越さない）", () => {
    expect(calculateReorder(basicList(), "b1", "up")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ORDER_ERRORS.cannotMoveUp,
    });
  });

  it("一覧の先頭を上へ動かそうとすると拒否される", () => {
    expect(calculateReorder(basicList(), "a1", "up")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ORDER_ERRORS.cannotMoveUp,
    });
  });

  it("一覧の末尾を下へ動かそうとすると拒否される", () => {
    expect(calculateReorder(basicList(), "b2", "down")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ORDER_ERRORS.cannotMoveDown,
    });
  });

  it("存在しない id は notFound", () => {
    expect(calculateReorder(basicList(), "no-such-id", "up")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ORDER_ERRORS.notFound,
    });
  });

  it("不正な方向は invalidDirection", () => {
    expect(calculateReorder(basicList(), "a1", "sideways" as never)).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ORDER_ERRORS.invalidDirection,
    });
  });

  it("空の一覧では notFound", () => {
    expect(calculateReorder([], "a1", "up")).toEqual({
      ok: false,
      error: PAYMENT_SOURCE_ORDER_ERRORS.notFound,
    });
  });

  it("未ソート・欠番・重複のある一覧を渡しても結果は 1..n の連番になる", () => {
    // x,y が sortOrder 重複(10)、z が大きく飛んだ欠番(500)。渡す順もバラバラ
    const list: PaymentSourceOrderItem[] = [
      { id: "z", sortOrder: 500, isActive: true },
      { id: "x", sortOrder: 10, isActive: true },
      { id: "y", sortOrder: 10, isActive: true },
    ];
    // 表示順: x, y, z（同値は id 昇順） → z を上へ動かすと y と入れ替わる
    const result = calculateReorder(list, "z", "up");
    expect(result).toEqual({
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
    calculateReorder(list, "a1", "down");
    expect(list).toEqual(before);
  });
});

describe("canMovePaymentSource と calculateReorder の可否判断が常に一致する", () => {
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
    const can = canMovePaymentSource(list, id, direction);
    const result = calculateReorder(list, id, direction);
    expect(result.ok).toBe(can);
  });
});
