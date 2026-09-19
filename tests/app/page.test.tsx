// src/app/page.tsx（ダッシュボード）の「配線」を検証する。
//
// Step 6 でこのファイルは暫定リンク集から、searchParams を受け取る async Server
// Component（ダッシュボード）へ置き換わった。集計そのもの（目安・着地見込み・
// 消化率の並べ替え等）は tests/lib/dashboard.test.ts で、表示の枝分かれは
// tests/app/dashboard-view.test.tsx で既に検証済みのため、ここでは重複させず
// 「page.tsx だけが持つ配線」だけを見る:
//
// - searchParams（Promise）から対象月を解決する経路（?month= 未指定・不正・配列）
// - getDashboardData（データ層）の呼び出しと、その戻り値が正しく
//   src/lib/dashboard.ts の各 build* 関数へ渡ること
// - 「表示中の月の収入」と「収支に使う前月の収入」を取り違えていないこと
//   （data.incomes と data.previousMonthIncomes は形が同じで、入れ替わっても
//    型では検出できない）
// - 浪費（WASTE）集計が今月の無駄使いに渡ること
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-5. 画面 > /（ダッシュボード）」
//   「対象月は ?month=YYYY-MM（未指定なら今月）」
// - docs/steps/step-6.md「設計判断 2」（収支 = 前月の収入 − 表示中の月の支出）
// - docs/steps/step-6.md「tester への引き継ぎ > 既知の未対応」
//   （旧テストが `render(<HomePage />)` のままで型エラーになり、書き直しが必要と明記）
// - src/lib/year-month.ts の resolveYearMonth（不正・配列は today にフォールバック）
// - 手計算（コメントに根拠を残す）

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardData } from "@/lib/dashboard-data";
import type { UserId } from "@/lib/user-id";

const USER_ID = "user_1" as UserId;

const getDashboardDataMock =
  vi.fn<(client: unknown, userId: UserId, yearMonth: string) => Promise<DashboardData>>();

vi.mock("next/server", () => ({
  // page.tsx は connection() でプリレンダリングを止めるだけ。
  // 実際の Next.js のリクエストスコープが無いテスト環境では素通りさせる
  connection: async () => undefined,
}));

vi.mock("@/lib/session", () => ({
  requireUserId: async () => USER_ID,
  destroySession: async () => {},
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/dashboard-data", () => ({
  getDashboardData: (client: unknown, userId: UserId, yearMonth: string) =>
    getDashboardDataMock(client, userId, yearMonth),
}));

const { default: HomePage } = await import("@/app/page");
const { MIN_YEAR_MONTH } = await import("@/lib/year-month");
const { PaymentSourceType, WasteTag, CostType } = await import("@/generated/prisma/enums");
const { EXPENSES_PATH, NEW_EXPENSE_PATH } = await import("@/app/expenses/action-state");
const { BUDGETS_PATH } = await import("@/app/budgets/action-state");
const { INCOMES_PATH } = await import("@/app/incomes/action-state");
const { PAYMENT_SOURCES_PATH } = await import("@/app/settings/payment-sources/action-state");
const { CATEGORIES_PATH } = await import("@/app/settings/categories/action-state");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 対象月に該当データが1件も無い最小の DashboardData */
function emptyDashboardData(yearMonth: string): DashboardData {
  return {
    yearMonth,
    paymentSources: [],
    categories: [],
    budgets: [],
    categoryBudgets: [],
    expenses: [],
    incomes: [],
    previousMonthIncomes: [],
  };
}

type PaymentSourceFixture = DashboardData["paymentSources"][number];
type CategoryFixture = DashboardData["categories"][number];
type BudgetFixture = DashboardData["budgets"][number];
type ExpenseFixture = DashboardData["expenses"][number];
type IncomeFixture = DashboardData["incomes"][number];

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

function buildPaymentSource(overrides: Partial<PaymentSourceFixture> = {}): PaymentSourceFixture {
  return {
    id: nextId("ps"),
    userId: USER_ID,
    name: "払い出し先",
    type: PaymentSourceType.CASH,
    sortOrder: 0,
    isActive: true,
    isDefault: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildCategory(overrides: Partial<CategoryFixture> = {}): CategoryFixture {
  return {
    id: nextId("cat"),
    userId: USER_ID,
    name: "カテゴリ",
    costType: CostType.VARIABLE,
    sortOrder: 0,
    isHidden: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildBudget(overrides: Partial<BudgetFixture> = {}): BudgetFixture {
  return {
    id: nextId("budget"),
    userId: USER_ID,
    paymentSourceId: "ps_1",
    yearMonth: "2026-07",
    amountYen: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildExpense(overrides: Partial<ExpenseFixture> = {}): ExpenseFixture {
  return {
    id: nextId("exp"),
    userId: USER_ID,
    date: new Date("2026-07-05T00:00:00.000Z"),
    amountYen: 0,
    categoryId: "cat_1",
    paymentSourceId: "ps_1",
    storeName: null,
    memo: null,
    wasteTag: WasteTag.NECESSARY,
    createdAt: new Date("2026-07-05T00:00:00.000Z"),
    updatedAt: new Date("2026-07-05T00:00:00.000Z"),
    ...overrides,
  };
}

function buildIncome(overrides: Partial<IncomeFixture> = {}): IncomeFixture {
  return {
    id: nextId("income"),
    userId: USER_ID,
    yearMonth: "2026-07",
    amountYen: 0,
    label: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** heading の直近の <section> だけを見る（同じ表記の値が他の節にも出るため） */
function sectionOf(heading: HTMLElement): HTMLElement {
  const section = heading.closest("section");
  if (!section) throw new Error(`"${heading.textContent}" の <section> が見つかりません`);
  return section as HTMLElement;
}

describe("対象月の解決", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-08-14T00:00:00Z = JST 2026-08-14 09:00。今日は 2026年8月14日
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    getDashboardDataMock.mockReset();
  });

  it("?month 未指定なら今月（JST）を対象にする", async () => {
    getDashboardDataMock.mockResolvedValue(emptyDashboardData("2026-08"));
    const jsx = await HomePage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(
      screen.getByRole("heading", { name: "2026年8月の残り使える金額" }),
    ).toBeInTheDocument();
    expect(getDashboardDataMock).toHaveBeenCalledWith(expect.anything(), USER_ID, "2026-08");
  });

  it("?month=2026-07 を指定すればその月を対象にする", async () => {
    getDashboardDataMock.mockResolvedValue(emptyDashboardData("2026-07"));
    const jsx = await HomePage({ searchParams: Promise.resolve({ month: "2026-07" }) });
    render(jsx);

    expect(
      screen.getByRole("heading", { name: "2026年7月の残り使える金額" }),
    ).toBeInTheDocument();
    expect(getDashboardDataMock).toHaveBeenCalledWith(expect.anything(), USER_ID, "2026-07");
    // 表示中の月が今月と異なるので月ナビに「今月へ」が出る（今月＝2026年8月であること自体の確認）
    expect(
      screen.getByRole("link", { name: "今月（2026年8月）へ" }),
    ).toBeInTheDocument();
  });

  it("?month が不正な形式なら今月にフォールバックする", async () => {
    getDashboardDataMock.mockResolvedValue(emptyDashboardData("2026-08"));
    const jsx = await HomePage({ searchParams: Promise.resolve({ month: "not-a-month" }) });
    render(jsx);

    expect(getDashboardDataMock).toHaveBeenCalledWith(expect.anything(), USER_ID, "2026-08");
    expect(
      screen.getByRole("heading", { name: "2026年8月の残り使える金額" }),
    ).toBeInTheDocument();
  });

  it("?month が配列（クエリの重複指定）なら今月にフォールバックする", async () => {
    getDashboardDataMock.mockResolvedValue(emptyDashboardData("2026-08"));
    const jsx = await HomePage({
      searchParams: Promise.resolve({ month: ["2026-07", "2026-09"] }),
    });
    render(jsx);

    expect(getDashboardDataMock).toHaveBeenCalledWith(expect.anything(), USER_ID, "2026-08");
  });

  it("?month が扱える範囲の下限（0000-01）でも例外を投げずに描画する", async () => {
    // buildIncomeBalance は previousMonthIncomes が空なら previousYearMonth を呼ばないため、
    // getDashboardData が実際にそうする（前月クエリを発行しない）挙動と揃えている限り安全
    // （tests/lib/dashboard-data.test.ts で検証済み）。ここでは page.tsx がその契約どおりに
    // 空配列を受け取って落ちないことだけを見る。
    getDashboardDataMock.mockResolvedValue(emptyDashboardData(MIN_YEAR_MONTH));
    const jsx = await HomePage({ searchParams: Promise.resolve({ month: MIN_YEAR_MONTH }) });

    expect(() => render(jsx)).not.toThrow();
    expect(getDashboardDataMock).toHaveBeenCalledWith(expect.anything(), USER_ID, MIN_YEAR_MONTH);
  });
});

describe("getDashboardData の戻り値の配線", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    getDashboardDataMock.mockReset();
    idCounter = 0;
  });

  it("残り使える金額・ペース・着地見込み・無駄使いを正しく組み立てる", async () => {
    // 2026-07 を表示中月として指定する（今日は 2026-08-14 なので過去月＝経過31/31日）
    const paymentSources = [
      buildPaymentSource({ id: "ps_1", name: "現金", type: PaymentSourceType.CASH, sortOrder: 0 }),
      buildPaymentSource({
        id: "ps_2",
        name: "銀行引き落とし",
        type: PaymentSourceType.BANK_DEBIT,
        sortOrder: 1,
      }),
    ];
    const categories = [buildCategory({ id: "cat_1", name: "食費" })];
    // ps_2 は予算を入れていない → unsetBudgetCount = 1
    const budgets = [buildBudget({ paymentSourceId: "ps_1", yearMonth: "2026-07", amountYen: 100_000 })];
    const expenses = [
      buildExpense({
        paymentSourceId: "ps_1",
        categoryId: "cat_1",
        amountYen: 30_000,
        wasteTag: WasteTag.WASTE,
      }),
      buildExpense({
        paymentSourceId: "ps_1",
        categoryId: "cat_1",
        amountYen: 20_000,
        wasteTag: WasteTag.NECESSARY,
      }),
    ];

    getDashboardDataMock.mockResolvedValue({
      yearMonth: "2026-07",
      paymentSources,
      categories,
      budgets,
      categoryBudgets: [],
      expenses,
      incomes: [],
      previousMonthIncomes: [],
    });

    const jsx = await HomePage({ searchParams: Promise.resolve({ month: "2026-07" }) });
    render(jsx);

    // 残り使える金額 = 総予算100,000 − 支出50,000(=30,000+20,000) = 50,000
    const remainingHeading = screen.getByRole("heading", {
      name: "2026年7月の残り使える金額",
    });
    const remainingSection = sectionOf(remainingHeading);
    expect(within(remainingSection).getByText("¥50,000")).toBeInTheDocument();
    expect(within(remainingSection).getByText(/総予算 ¥100,000/)).toBeInTheDocument();
    expect(within(remainingSection).getByText(/支出 ¥50,000/)).toBeInTheDocument();

    // ps_2 が有効かつ予算未設定なので、件数付きの注意が出る
    expect(
      screen.getByText(/予算が未設定の払い出し先が 1 件あります。/),
    ).toBeInTheDocument();

    // ペース: 7月は過去月なので elapsedDays = daysInMonth = 31（elapsedRatio = 1）
    // 目安 = floor(100,000 × 31 ÷ 31) = 100,000 / 実績 = 50,000 / 経過 = 31 / 31 日
    // 実績(50,000) は 目安(100,000) 未満なので status = under = 「予算内」
    const paceHeading = screen.getByRole("heading", { name: "ペース" });
    const paceSection = sectionOf(paceHeading);
    const withinPace = within(paceSection);
    expect(withinPace.getByText("予算内")).toBeInTheDocument();
    expect(withinPace.getByText("¥100,000")).toBeInTheDocument();
    // 「実績」の額は着地見込み（同じく50,000。経過31/31日=過去月なので偶然一致する）と
    // 表記が同じになるため、「実績」の dt の隣の dd に絞って見る
    const actualRow = withinPace.getByText("実績").closest("div");
    if (!actualRow) throw new Error("実績の行が見つかりません");
    expect(within(actualRow as HTMLElement).getByText("¥50,000")).toBeInTheDocument();
    expect(withinPace.getByText("31 / 31 日")).toBeInTheDocument();

    // 着地見込み = ceil(50,000 ÷ 31 × 31) = 50,000。総予算との差 = 100,000 − 50,000 = 50,000
    expect(withinPace.getByText("月末の着地見込み")).toBeInTheDocument();
    expect(withinPace.getByText(/総予算との差 ¥50,000/)).toBeInTheDocument();

    // 今月の無駄使い = WASTE のみ合計（30,000・1件）。NECESSARY の 20,000 は含まない
    const wasteHeading = screen.getByRole("heading", { name: "今月の無駄使い" });
    const wasteSection = sectionOf(wasteHeading);
    expect(within(wasteSection).getByText("¥30,000")).toBeInTheDocument();
    expect(within(wasteSection).getByText(/1件/)).toBeInTheDocument();

    // カテゴリ予算を1件も設定していないので、カテゴリ別の節は出ない
    expect(screen.queryByRole("heading", { name: "カテゴリ別" })).not.toBeInTheDocument();

    // 払い出し先別: 現金・銀行引き落としの両方が出て、ps_2 は「予算未設定」
    // 「現金」は払い出し先名とタイプのバッジ（PAYMENT_SOURCE_TYPE_LABELS.CASH）の
    // 両方に出るため、行（<li>）単位で見る
    const paymentHeading = screen.getByRole("heading", { name: "払い出し先別" });
    const paymentSection = sectionOf(paymentHeading);
    const paymentRows = within(paymentSection).getAllByRole("listitem");
    expect(paymentRows).toHaveLength(2);
    const cashRow = paymentRows.find((row) => row.textContent?.includes("¥100,000"));
    const bankRow = paymentRows.find((row) => row.textContent?.includes("予算未設定"));
    if (!cashRow || !bankRow) throw new Error("払い出し先別の行が見つかりません");
    // 払い出し先タイプのバッジも「現金」になるため名前は textContent で見る
    expect(cashRow.textContent).toContain("現金");
    expect(bankRow.textContent).toContain("銀行引き落とし");
  });

  it("今月の収入は data.incomes、収支の前月分は data.previousMonthIncomes から計算し、取り違えない", async () => {
    // 表示中の月（2026-07）の収入と前月（2026-06）の収入を、額を大きく変えて区別できるようにする。
    // 実装が2つを取り違えていれば、この2つの節の数字が入れ替わって出るので検出できる。
    const currentMonthIncomes = [buildIncome({ yearMonth: "2026-07", amountYen: 999, label: null })];
    const previousMonthIncomes = [
      buildIncome({ yearMonth: "2026-06", amountYen: 300_000, label: "給与" }),
      buildIncome({ yearMonth: "2026-06", amountYen: 200_000, label: "副業" }),
    ];
    const paymentSources = [buildPaymentSource({ id: "ps_1", name: "現金" })];
    const budgets = [buildBudget({ paymentSourceId: "ps_1", yearMonth: "2026-07", amountYen: 100_000 })];
    const expenses = [
      buildExpense({ paymentSourceId: "ps_1", categoryId: "cat_1", amountYen: 50_000 }),
    ];

    getDashboardDataMock.mockResolvedValue({
      yearMonth: "2026-07",
      paymentSources,
      categories: [],
      budgets,
      categoryBudgets: [],
      expenses,
      incomes: currentMonthIncomes,
      previousMonthIncomes,
    });

    const jsx = await HomePage({ searchParams: Promise.resolve({ month: "2026-07" }) });
    render(jsx);

    // 今月の収入 = data.incomes の合計（999円・1件）
    const monthlyIncomeHeading = screen.getByRole("heading", { name: "今月の収入" });
    const monthlyIncomeSection = sectionOf(monthlyIncomeHeading);
    expect(within(monthlyIncomeSection).getByText("¥999")).toBeInTheDocument();
    expect(within(monthlyIncomeSection).getByText("（1件）")).toBeInTheDocument();

    // 収支 = 前月(2026-06)の収入合計(500,000) − 表示中の月(2026-07)の支出(50,000) = 450,000
    const balanceHeading = screen.getByRole("heading", { name: "収支" });
    const balanceSection = sectionOf(balanceHeading);
    const withinBalance = within(balanceSection);
    expect(withinBalance.getByText("2026年6月の収入")).toBeInTheDocument();
    expect(withinBalance.getByText("¥500,000")).toBeInTheDocument();
    expect(withinBalance.getByText("2026年7月の支出")).toBeInTheDocument();
    expect(withinBalance.getByText("-¥50,000")).toBeInTheDocument();
    expect(withinBalance.getByText("¥450,000")).toBeInTheDocument();
  });

  it("前月の収入が0件なら収支の節ごと出さない", async () => {
    getDashboardDataMock.mockResolvedValue({
      ...emptyDashboardData("2026-07"),
      previousMonthIncomes: [],
    });

    const jsx = await HomePage({ searchParams: Promise.resolve({ month: "2026-07" }) });
    render(jsx);

    expect(screen.queryByRole("heading", { name: "収支" })).not.toBeInTheDocument();
    // 今月の収入の枠自体は残る（0件でも記録を促すため）
    expect(screen.getByRole("heading", { name: "今月の収入" })).toBeInTheDocument();
  });

  it("総予算が0円ならペース節を出さず、予算未設定の案内を出す", async () => {
    getDashboardDataMock.mockResolvedValue({
      ...emptyDashboardData("2026-07"),
      paymentSources: [buildPaymentSource({ id: "ps_1", name: "現金" })],
    });

    const jsx = await HomePage({ searchParams: Promise.resolve({ month: "2026-07" }) });
    render(jsx);

    expect(
      screen.getByText(/この月の予算がまだ設定されていません。/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "ペース" })).not.toBeInTheDocument();
  });
});

describe("主要な画面へのリンクとログアウト", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
    getDashboardDataMock.mockReset();
    getDashboardDataMock.mockResolvedValue(emptyDashboardData("2026-08"));
  });

  it("h1 は『家計簿』", async () => {
    const jsx = await HomePage({ searchParams: Promise.resolve({}) });
    render(jsx);
    expect(screen.getByRole("heading", { level: 1, name: "家計簿" })).toBeInTheDocument();
  });

  it("支出一覧・月次予算・収入・払い出し先・カテゴリ・支出登録のリンクを持つ", async () => {
    const jsx = await HomePage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(screen.getByRole("link", { name: /支出一覧/ })).toHaveAttribute("href", EXPENSES_PATH);
    expect(screen.getByRole("link", { name: /月次予算/ })).toHaveAttribute("href", BUDGETS_PATH);
    expect(screen.getByRole("link", { name: "収入" })).toHaveAttribute("href", INCOMES_PATH);
    expect(screen.getByRole("link", { name: /払い出し先の設定/ })).toHaveAttribute(
      "href",
      PAYMENT_SOURCES_PATH,
    );
    expect(screen.getByRole("link", { name: /カテゴリの設定/ })).toHaveAttribute(
      "href",
      CATEGORIES_PATH,
    );
    expect(screen.getByRole("link", { name: "支出を記録する" })).toHaveAttribute(
      "href",
      NEW_EXPENSE_PATH,
    );
  });

  it("ログアウトボタンがある", async () => {
    const jsx = await HomePage({ searchParams: Promise.resolve({}) });
    render(jsx);
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeInTheDocument();
  });
});
