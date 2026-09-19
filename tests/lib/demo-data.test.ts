// @vitest-environment node
//
// src/lib/demo-data.ts（デモアカウントの定数と、サンプルデータの純粋関数生成）を検証する。
// 実データベースには接続しない。
//
// 期待値の根拠:
// - docs/steps/pub-3.md 設計判断 1・2・8（このファイルの JSDoc に写してある「仕様の出典」）
//   「DEMO_TTL_HOURS = 24」
//   「セッションの JWT の exp と Cookie の maxAge を demoExpiresAt に揃える」
//   「乱数を使わない。同じ今日からは必ず同じデータになる」
//   「今日の日付によらず成り立つこと」1〜5:
//     1. 今月の支出は今日以前の日付だけ
//     2. 今月の総予算に対して残額がプラス
//     3. 少なくとも1つの払い出し先が、今日時点の理想消化額を上回る
//        （ダッシュボードのペース判定で「要注意」か「超過」の色が出る）
//     4. 今月の浪費タグの合計が0より大きい
//     5. 前月と比べて増えたカテゴリが少なくとも1つある
//   「店名・メモは一般名詞だけ。実在の店名・ブランド名・銀行名を使わない」
// - docs/steps/pub-3.md「実装完了後の引き継ぎ」
//   「buildDemoData(today: "YYYY-MM-DD") → DemoDataPlan（yearMonths / paymentSources
//    （現金以外の追加分）/ budgets / categoryBudgets / incomes / expenses。関連先は名前で参照）」
//   「getDemoExpiresAt(now)（秒に切り捨て＋24時間）、getDemoSessionMaxAgeSeconds(expiresAt, now)、
//    formatDemoExpiresAtLabel(expiresAt)（JST）」
// - docs/steps/pub-3.md「tester 向けの方針」5
//   「1年分の全日付（閏年の2月29日と月末・月初を含む）で確かめる。乱数を使っていない
//    （同じ日付で同じ結果）。店名・メモ・払い出し先名が一般名詞だけであること。
//    投入時に全行の userId が作ったユーザーであること」
//
// 性質1〜5の判定は、日付によって変わる具体的な金額を手で書き下すのではなく、
// 実装が公開している判定ロジック（getMonthProgress / calculateExpectedYen /
// judgePaceStatus。既存の src/lib/dashboard.ts。tests/lib/dashboard.test.ts で
// 検証済み）を「ものさし」として buildDemoData の出力そのものから計算する。
// これにより「実装の出力に期待値を合わせる」のではなく、
// 「buildDemoData の出力が設計判断8の性質を満たすか」を独立に判定できる。

import { describe, expect, it } from "vitest";

import { PaymentSourceType, WasteTag } from "@/generated/prisma/enums";
import {
  calculateExpectedYen,
  getMonthProgress,
  judgePaceStatus,
} from "@/lib/dashboard";
import {
  buildDemoData,
  DEMO_BANK_NAME,
  DEMO_CARD_NAME,
  DEMO_CASH_NAME,
  DEMO_MONTH_COUNT,
  DEMO_MONTHLY_BUDGETS,
  DEMO_MONTHLY_CATEGORY_BUDGETS,
  DEMO_MONTHLY_INCOME,
  DEMO_PAYMENT_SOURCES,
  DEMO_TTL_HOURS,
  formatDemoExpiresAtLabel,
  getDemoExpiresAt,
  getDemoSessionMaxAgeSeconds,
} from "@/lib/demo-data";
import { addDaysToDate, compareDateStrings } from "@/lib/expense-date";
import { PRESET_CATEGORIES } from "@/lib/seed";

/* ------------------------------------------------------------------ *
 * 定数
 * ------------------------------------------------------------------ */

describe("定数", () => {
  it("DEMO_TTL_HOURS は24時間（設計判断2）", () => {
    expect(DEMO_TTL_HOURS).toBe(24);
  });

  it("DEMO_MONTH_COUNT は4か月（今月＋前3か月。設計判断8）", () => {
    expect(DEMO_MONTH_COUNT).toBe(4);
  });

  it("DEMO_PAYMENT_SOURCES は現金以外の追加分2件（Aカード＝クレジットカード、A銀行 引き落とし＝銀行引き落とし）", () => {
    expect(DEMO_PAYMENT_SOURCES).toEqual([
      { name: DEMO_CARD_NAME, type: PaymentSourceType.CREDIT_CARD, sortOrder: 2 },
      { name: DEMO_BANK_NAME, type: PaymentSourceType.BANK_DEBIT, sortOrder: 3 },
    ]);
  });

  it("払い出し先名・カテゴリ予算名は一般名詞のプリセットカテゴリに含まれる（demo-seed が解決できる名前であること）", () => {
    const presetNames = new Set(PRESET_CATEGORIES.map((c) => c.name));
    for (const budget of DEMO_MONTHLY_CATEGORY_BUDGETS) {
      expect(presetNames.has(budget.categoryName)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * getDemoExpiresAt（設計判断 2: 秒に切り捨て + 24時間）
 * ------------------------------------------------------------------ */

describe("getDemoExpiresAt", () => {
  it("24時間後（手計算: 24*60*60*1000 = 86,400,000ms）", () => {
    const now = new Date("2026-01-15T00:00:00.000Z");
    expect(getDemoExpiresAt(now)).toEqual(new Date("2026-01-16T00:00:00.000Z"));
  });

  it("秒未満は切り捨ててから24時間を足す（ミリ秒は結果に残らない）", () => {
    const now = new Date("2026-01-15T00:00:00.999Z");
    // floor(now/1000) = 2026-01-15T00:00:00.000Z のち +24h
    expect(getDemoExpiresAt(now)).toEqual(new Date("2026-01-16T00:00:00.000Z"));
  });

  it("月・年をまたぐ（2026-01-31 → 2026-02-01、2026-12-31 → 2027-01-01）", () => {
    expect(getDemoExpiresAt(new Date("2026-01-31T12:00:00.000Z"))).toEqual(
      new Date("2026-02-01T12:00:00.000Z"),
    );
    expect(getDemoExpiresAt(new Date("2026-12-31T23:00:00.000Z"))).toEqual(
      new Date("2027-01-01T23:00:00.000Z"),
    );
  });

  it("うるう年の2月29日をまたぐ（2024-02-29 → 2024-03-01）", () => {
    expect(getDemoExpiresAt(new Date("2024-02-29T05:00:00.000Z"))).toEqual(
      new Date("2024-03-01T05:00:00.000Z"),
    );
  });

  it("不正な Date は RangeError", () => {
    expect(() => getDemoExpiresAt(new Date("not-a-date"))).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ *
 * getDemoSessionMaxAgeSeconds（設計判断 2: セッションの exp を demoExpiresAt に揃える）
 * ------------------------------------------------------------------ */

describe("getDemoSessionMaxAgeSeconds", () => {
  it("now から expiresAt までの秒数（手計算: 24時間 = 86,400秒）", () => {
    const now = new Date("2026-01-15T00:00:00.000Z");
    const expiresAt = getDemoExpiresAt(now);
    expect(getDemoSessionMaxAgeSeconds(expiresAt, now)).toBe(86_400);
  });

  it("now が expiresAt ちょうどなら 0", () => {
    const expiresAt = new Date("2026-01-16T00:00:00.000Z");
    expect(getDemoSessionMaxAgeSeconds(expiresAt, expiresAt)).toBe(0);
  });

  it("now が expiresAt を過ぎていても負数にならない（0に丸める）", () => {
    const expiresAt = new Date("2026-01-16T00:00:00.000Z");
    const later = new Date("2026-01-16T00:00:10.000Z");
    expect(getDemoSessionMaxAgeSeconds(expiresAt, later)).toBe(0);
  });

  it("秒未満は両方とも切り捨ててから引く", () => {
    const expiresAt = new Date("2026-01-16T00:00:00.700Z");
    const now = new Date("2026-01-15T23:59:59.900Z");
    // floor(expiresAt/1000)=...:00, floor(now/1000)=...:59 → 差は1秒
    expect(getDemoSessionMaxAgeSeconds(expiresAt, now)).toBe(1);
  });

  it("不正な Date は RangeError", () => {
    const valid = new Date("2026-01-15T00:00:00.000Z");
    expect(() => getDemoSessionMaxAgeSeconds(new Date("bad"), valid)).toThrow(RangeError);
    expect(() => getDemoSessionMaxAgeSeconds(valid, new Date("bad"))).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ *
 * formatDemoExpiresAtLabel（JST 表示）
 * ------------------------------------------------------------------ */

describe("formatDemoExpiresAtLabel", () => {
  it("UTC 深夜をまたいで JST の翌日になる（18:05 UTC → 翌日03:05 JST）", () => {
    expect(formatDemoExpiresAtLabel(new Date("2026-09-19T18:05:00.000Z"))).toBe(
      "2026/9/20 03:05",
    );
  });

  it("日中はそのまま日付が進まない（09:00 UTC → 18:00 JST 同日）", () => {
    expect(formatDemoExpiresAtLabel(new Date("2026-09-19T09:00:00.000Z"))).toBe(
      "2026/9/19 18:00",
    );
  });

  it("時・分は2桁ゼロ埋め（0:05 UTC → 09:05 JST）", () => {
    expect(formatDemoExpiresAtLabel(new Date("2026-09-19T00:05:00.000Z"))).toBe(
      "2026/9/19 09:05",
    );
  });

  it("月・日は先頭ゼロを付けない（1月1日）", () => {
    expect(formatDemoExpiresAtLabel(new Date("2026-01-01T00:00:00.000Z"))).toBe(
      "2026/1/1 09:00",
    );
  });

  it("年をまたぐ（2026-12-31T15:30 UTC → 2027/1/1 00:30 JST）", () => {
    expect(formatDemoExpiresAtLabel(new Date("2026-12-31T15:30:00.000Z"))).toBe(
      "2027/1/1 00:30",
    );
  });

  it("不正な Date は RangeError", () => {
    expect(() => formatDemoExpiresAtLabel(new Date("bad"))).toThrow(RangeError);
  });
});

/* ------------------------------------------------------------------ *
 * buildDemoData — 入力の検証・構造
 * ------------------------------------------------------------------ */

describe("buildDemoData — 不正な today", () => {
  it.each([
    ["空文字", ""],
    ["区切りが違う", "2026/08/14"],
    ["実在しない日付（2月30日）", "2026-02-30"],
    ["実在しない日付（うるう年でない年の2月29日）", "2025-02-29"],
    ["月が範囲外", "2026-13-01"],
    ["日付ですらない文字列", "not-a-date"],
  ])("%s は RangeError", (_label, value) => {
    expect(() => buildDemoData(value)).toThrow(RangeError);
  });
});

describe("buildDemoData — yearMonths（今月と前3か月、昇順）", () => {
  it("2026-08-14 → [2026-05, 2026-06, 2026-07, 2026-08]（最後が今月）", () => {
    expect(buildDemoData("2026-08-14").yearMonths).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
  });

  it("年をまたぐ: 2026-01-15 → [2025-10, 2025-11, 2025-12, 2026-01]", () => {
    expect(buildDemoData("2026-01-15").yearMonths).toEqual([
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });

  it("うるう年の2月29日が今日でも例外にならない", () => {
    expect(() => buildDemoData("2024-02-29")).not.toThrow();
    expect(buildDemoData("2024-02-29").yearMonths).toEqual([
      "2023-11",
      "2023-12",
      "2024-01",
      "2024-02",
    ]);
  });
});

describe("buildDemoData — paymentSources（今日に依存しない）", () => {
  it("DEMO_PAYMENT_SOURCES のコピーを返す", () => {
    expect(buildDemoData("2026-01-01").paymentSources).toEqual(DEMO_PAYMENT_SOURCES);
    expect(buildDemoData("2028-12-31").paymentSources).toEqual(DEMO_PAYMENT_SOURCES);
  });
});

describe("buildDemoData — budgets / categoryBudgets / incomes（4か月分、各月同じ内容）", () => {
  const plan = buildDemoData("2026-08-14");

  it("budgets は 4か月 × DEMO_MONTHLY_BUDGETS.length 件", () => {
    expect(plan.budgets).toHaveLength(DEMO_MONTH_COUNT * DEMO_MONTHLY_BUDGETS.length);
    for (const yearMonth of plan.yearMonths) {
      for (const budget of DEMO_MONTHLY_BUDGETS) {
        expect(plan.budgets).toContainEqual({ yearMonth, ...budget });
      }
    }
  });

  it("categoryBudgets は 4か月 × DEMO_MONTHLY_CATEGORY_BUDGETS.length 件", () => {
    expect(plan.categoryBudgets).toHaveLength(
      DEMO_MONTH_COUNT * DEMO_MONTHLY_CATEGORY_BUDGETS.length,
    );
    for (const yearMonth of plan.yearMonths) {
      for (const categoryBudget of DEMO_MONTHLY_CATEGORY_BUDGETS) {
        expect(plan.categoryBudgets).toContainEqual({ yearMonth, ...categoryBudget });
      }
    }
  });

  it("incomes は月ごとに1件、DEMO_MONTHLY_INCOME の内容", () => {
    expect(plan.incomes).toHaveLength(DEMO_MONTH_COUNT);
    for (const yearMonth of plan.yearMonths) {
      expect(plan.incomes).toContainEqual({ yearMonth, ...DEMO_MONTHLY_INCOME });
    }
  });
});

describe("buildDemoData — 決定性（乱数を使わない。設計判断8）", () => {
  it.each(["2026-01-01", "2024-02-29", "2026-08-14", "2026-12-31"])(
    "同じ today (%s) なら常に同じ結果",
    (today) => {
      expect(buildDemoData(today)).toEqual(buildDemoData(today));
    },
  );
});

describe("buildDemoData — expenses の並び（日付の昇順）", () => {
  it.each(["2026-01-01", "2024-02-29", "2026-08-14", "2026-12-31"])(
    "today=%s: expenses は日付の昇順",
    (today) => {
      const { expenses } = buildDemoData(today);
      for (let i = 1; i < expenses.length; i += 1) {
        expect(compareDateStrings(expenses[i - 1].date, expenses[i].date)).toBeLessThanOrEqual(0);
      }
    },
  );
});

describe("buildDemoData — 一般名詞のみ（実在の店名・ブランド名・銀行名を使わない）", () => {
  // 実在するとまぎらわしい固有名詞（銀行・カードブランド・チェーン店名）の一部。
  // 完全な網羅は不可能だが、実装が誤って実在名を使えば高確率で検出できる代表例。
  const FORBIDDEN_SUBSTRINGS = [
    "三菱",
    "みずほ",
    "りそな",
    "三井住友",
    "ゆうちょ",
    "楽天",
    "PayPay",
    "Suica",
    "Visa",
    "Mastercard",
    "JCB",
    "AMEX",
    "セブン",
    "イオン",
    "ファミリーマート",
    "ローソン",
    "スターバックス",
    "ドン・キホーテ",
    "イトーヨーカドー",
  ];

  it("払い出し先名（Aカード・A銀行 引き落とし）に実在ブランド名を含まない", () => {
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(DEMO_CARD_NAME).not.toContain(forbidden);
      expect(DEMO_BANK_NAME).not.toContain(forbidden);
    }
  });

  it(
    "店名・メモに実在ブランド名を含まない（1年分の全日付。出現しうる値を重複排除してから判定する）",
    () => {
      // 1年分の全日付を毎回 expect() で判定すると assert 回数が膨大になり遅いため、
      // まず「実際に出現しうる storeName・memo の種類」を重複排除して集め、
      // その種類（有限個のテンプレート由来）だけを判定する。1年分すべての日付を
      // 生成して集める点は変えていないので、検出できる範囲は変わらない。
      const seenStoreNames = new Set<string>();
      const seenMemos = new Set<string>();
      for (const today of iterateDates("2023-01-01", "2024-12-31")) {
        const { expenses } = buildDemoData(today);
        for (const expense of expenses) {
          if (expense.storeName) seenStoreNames.add(expense.storeName);
          if (expense.memo) seenMemos.add(expense.memo);
        }
      }

      // 空振り防止: 実際に何らかの店名・メモが存在していること
      expect(seenStoreNames.size).toBeGreaterThan(0);
      expect(seenMemos.size).toBeGreaterThan(0);

      for (const value of [...seenStoreNames, ...seenMemos]) {
        for (const forbidden of FORBIDDEN_SUBSTRINGS) {
          expect(value).not.toContain(forbidden);
        }
      }
    },
    20_000,
  );
});

describe("buildDemoData — 関連先の名前がすべて解決できる（demo-seed が throw しないこと）", () => {
  const presetCategoryNames = new Set(PRESET_CATEGORIES.map((c) => c.name));
  const paymentSourceNames = new Set([DEMO_CASH_NAME, DEMO_CARD_NAME, DEMO_BANK_NAME]);

  it("1年分の全日付で、expenses・categoryBudgets の categoryName は PRESET_CATEGORIES に含まれる", () => {
    for (const today of iterateDates("2023-01-01", "2024-12-31")) {
      const plan = buildDemoData(today);
      for (const expense of plan.expenses) {
        expect(presetCategoryNames.has(expense.categoryName)).toBe(true);
      }
      for (const categoryBudget of plan.categoryBudgets) {
        expect(presetCategoryNames.has(categoryBudget.categoryName)).toBe(true);
      }
    }
  });

  it("1年分の全日付で、expenses・budgets の paymentSourceName は現金/Aカード/A銀行のいずれか", () => {
    for (const today of iterateDates("2023-01-01", "2024-12-31")) {
      const plan = buildDemoData(today);
      for (const expense of plan.expenses) {
        expect(paymentSourceNames.has(expense.paymentSourceName)).toBe(true);
      }
      for (const budget of plan.budgets) {
        expect(paymentSourceNames.has(budget.paymentSourceName)).toBe(true);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 「今日の日付によらず成り立つこと」1〜5（設計判断8）
 * 1年分以上の全日付（2023-01-01〜2024-12-31。うるう年の2月29日を含む）で確かめる。
 * ------------------------------------------------------------------ */

/** [startDate, endDate] の "YYYY-MM-DD" を1日ずつ列挙する（両端含む） */
function* iterateDates(startDate: string, endDate: string): Generator<string> {
  let current = startDate;
  while (compareDateStrings(current, endDate) <= 0) {
    yield current;
    current = addDaysToDate(current, 1);
  }
}

describe("今日の日付によらず成り立つこと（設計判断8。1年分以上・うるう年の2/29を含む全日付）", () => {
  const dates = [...iterateDates("2023-01-01", "2024-12-31")];

  // 1年分以上を確かめていること自体の自己チェック（テストが空振りしていないことの保証）
  it("対象日数が1年（365日）を超えている", () => {
    expect(dates.length).toBeGreaterThan(365);
  });
  it("うるう年の2月29日を含んでいる", () => {
    expect(dates).toContain("2024-02-29");
  });
  it("月初（1日）・月末（28〜31日）を含んでいる", () => {
    expect(dates.some((d) => d.endsWith("-01"))).toBe(true);
    expect(dates.some((d) => d.endsWith("-28"))).toBe(true);
    expect(dates.some((d) => d.endsWith("-30"))).toBe(true);
    expect(dates.some((d) => d.endsWith("-31"))).toBe(true);
  });

  for (const today of dates) {
    it(`today=${today}: 性質1〜5をすべて満たす`, () => {
      const plan = buildDemoData(today);
      const currentYearMonth = plan.yearMonths[plan.yearMonths.length - 1];
      const previousYearMonth = plan.yearMonths[plan.yearMonths.length - 2];

      const currentMonthExpenses = plan.expenses.filter((e) => e.date.startsWith(currentYearMonth));
      const previousMonthExpenses = plan.expenses.filter((e) =>
        e.date.startsWith(previousYearMonth),
      );

      // 1. 今月の支出は今日以前の日付だけ（未来の支出を作らない）
      for (const expense of currentMonthExpenses) {
        expect(compareDateStrings(expense.date, today)).toBeLessThanOrEqual(0);
      }

      // 2. 今月の総予算に対して残額がプラス
      const currentMonthBudgets = plan.budgets.filter((b) => b.yearMonth === currentYearMonth);
      const totalBudget = currentMonthBudgets.reduce((sum, b) => sum + b.amountYen, 0);
      const totalSpent = currentMonthExpenses.reduce((sum, e) => sum + e.amountYen, 0);
      expect(totalSpent).toBeLessThan(totalBudget);

      // 3. 少なくとも1つの払い出し先が、今日時点の理想消化額を上回る
      //    （ペース判定が warning か over になる払い出し先が1つ以上ある）
      const progress = getMonthProgress(currentYearMonth, today);
      const spentByPaymentSource = new Map<string, number>();
      for (const expense of currentMonthExpenses) {
        spentByPaymentSource.set(
          expense.paymentSourceName,
          (spentByPaymentSource.get(expense.paymentSourceName) ?? 0) + expense.amountYen,
        );
      }
      const overOrWarning = currentMonthBudgets.some((budget) => {
        const spent = spentByPaymentSource.get(budget.paymentSourceName) ?? 0;
        const expected = calculateExpectedYen(budget.amountYen, progress);
        const status = judgePaceStatus(budget.amountYen, spent, expected);
        return status === "warning" || status === "over";
      });
      expect(overOrWarning).toBe(true);

      // 4. 今月の浪費タグの合計が0より大きい
      const wasteTotal = currentMonthExpenses
        .filter((e) => e.wasteTag === WasteTag.WASTE)
        .reduce((sum, e) => sum + e.amountYen, 0);
      expect(wasteTotal).toBeGreaterThan(0);

      // 5. 前月と比べて増えたカテゴリが少なくとも1つある
      const currentByCategory = new Map<string, number>();
      for (const expense of currentMonthExpenses) {
        currentByCategory.set(
          expense.categoryName,
          (currentByCategory.get(expense.categoryName) ?? 0) + expense.amountYen,
        );
      }
      const previousByCategory = new Map<string, number>();
      for (const expense of previousMonthExpenses) {
        previousByCategory.set(
          expense.categoryName,
          (previousByCategory.get(expense.categoryName) ?? 0) + expense.amountYen,
        );
      }
      const someCategoryIncreased = [...currentByCategory.entries()].some(
        ([category, amount]) => amount > (previousByCategory.get(category) ?? 0),
      );
      expect(someCategoryIncreased).toBe(true);
    });
  }
});

describe("today を1日進めても、今月の支出は減らない（超集合になる。追加のみで欠落が無いことの確認）", () => {
  it("同じ月内で day を1〜28まで進めると、前日までの支出をすべて含んだまま増える", () => {
    const base = "2026-06"; // 30日ある月
    let previousExpenses: string[] = [];
    for (let day = 1; day <= 28; day += 1) {
      const today = `${base}-${String(day).padStart(2, "0")}`;
      const plan = buildDemoData(today);
      const currentMonthExpenses = plan.expenses.filter((e) => e.date.startsWith(base));
      const ids = currentMonthExpenses.map((e) => `${e.date}|${e.categoryName}|${e.amountYen}|${e.storeName}|${e.memo}`);
      for (const previous of previousExpenses) {
        expect(ids).toContain(previous);
      }
      previousExpenses = ids;
    }
  });
});
