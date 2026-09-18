// src/app/incomes/page.tsx（収入の入力。searchParams を受け取る async Server Component）の
// 「配線」を検証する。フォーム自体の挙動は tests/app/incomes/income-form.test.tsx、
// 一覧・削除の挙動は tests/app/incomes/income-list.test.tsx、Server Action の中身は
// tests/app/incomes/actions.test.ts で既に検証済みのため、ここでは重複させず
// page.tsx だけが持つ配線（対象月の解決・listIncomes の呼び出しと合計・一覧への受け渡し・
// 「受け取った月」の明示）だけを見る（tests/app/page.test.tsx と同じ方針）。
//
// 期待値の根拠:
// - docs/steps/step-6.md「3-5. 画面 > /incomes」
//   「月ナビゲーション」「追加フォーム」「その月の一覧（新しい順、各行に削除）」
//   「合計を上部に表示」「月の見出しに『受け取った月』と明示すること」
// - docs/steps/step-6.md「tester への引き継ぎ > 画面の主な見出し・文言」
//   「h1 = 収入、h2 = 2026年8月に受け取った収入 / 収入を追加。
//    一覧が空のとき この月に受け取った収入はまだ記録されていません。」
// - 手計算（コメントに根拠を残す）

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Income } from "@/generated/prisma/client";
import type { UserId } from "@/lib/user-id";

const USER_ID = "user_1" as UserId;

const listIncomesMock =
  vi.fn<(client: unknown, userId: UserId, yearMonth: string) => Promise<Income[]>>();

vi.mock("next/server", () => ({
  connection: async () => undefined,
}));

vi.mock("@/lib/session", () => ({
  requireUserId: async () => USER_ID,
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/incomes", async () => {
  const actual = await vi.importActual<typeof import("@/lib/incomes")>("@/lib/incomes");
  return {
    ...actual,
    listIncomes: (client: unknown, userId: UserId, yearMonth: string) =>
      listIncomesMock(client, userId, yearMonth),
  };
});

const { default: IncomesPage } = await import("@/app/incomes/page");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

let idCounter = 0;
function buildIncome(overrides: Partial<Income> = {}): Income {
  idCounter += 1;
  return {
    id: `income_${idCounter}`,
    userId: USER_ID,
    yearMonth: "2026-08",
    amountYen: 0,
    label: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // 2026-08-14T00:00:00Z = JST 2026-08-14 09:00。今日は 2026年8月14日
  vi.setSystemTime(new Date("2026-08-14T00:00:00.000Z"));
  listIncomesMock.mockReset();
  idCounter = 0;
});

describe("対象月の解決", () => {
  it("?month 未指定なら今月（JST）を対象にする", async () => {
    listIncomesMock.mockResolvedValue([]);
    const jsx = await IncomesPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(
      screen.getByRole("heading", { name: "2026年8月に受け取った収入" }),
    ).toBeInTheDocument();
    expect(listIncomesMock).toHaveBeenCalledWith(expect.anything(), USER_ID, "2026-08");
  });

  it("?month=2026-07 を指定すればその月を対象にする", async () => {
    listIncomesMock.mockResolvedValue([]);
    const jsx = await IncomesPage({ searchParams: Promise.resolve({ month: "2026-07" }) });
    render(jsx);

    expect(
      screen.getByRole("heading", { name: "2026年7月に受け取った収入" }),
    ).toBeInTheDocument();
    expect(listIncomesMock).toHaveBeenCalledWith(expect.anything(), USER_ID, "2026-07");
  });

  it("?month が不正な形式なら今月にフォールバックする", async () => {
    listIncomesMock.mockResolvedValue([]);
    const jsx = await IncomesPage({
      searchParams: Promise.resolve({ month: "not-a-month" }),
    });
    render(jsx);

    expect(listIncomesMock).toHaveBeenCalledWith(expect.anything(), USER_ID, "2026-08");
  });
});

describe("見出しと一覧・合計の配線", () => {
  it("h1 は『収入』", async () => {
    listIncomesMock.mockResolvedValue([]);
    const jsx = await IncomesPage({ searchParams: Promise.resolve({}) });
    render(jsx);
    expect(screen.getByRole("heading", { level: 1, name: "収入" })).toBeInTheDocument();
  });

  it("一覧が空のとき『この月に受け取った収入はまだ記録されていません。』と合計¥0を出す", async () => {
    listIncomesMock.mockResolvedValue([]);
    const jsx = await IncomesPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(
      screen.getByText("この月に受け取った収入はまだ記録されていません。"),
    ).toBeInTheDocument();
    expect(screen.getByText("¥0")).toBeInTheDocument();
    expect(screen.getByText(/0件/)).toBeInTheDocument();
  });

  it("listIncomes の戻り値の合計を上部に表示し、各行をラベル・金額で一覧に渡す", async () => {
    // 手計算: 300,000 + 50,000 = 350,000
    listIncomesMock.mockResolvedValue([
      buildIncome({ id: "income_1", amountYen: 300_000, label: "給与" }),
      buildIncome({ id: "income_2", amountYen: 50_000, label: "副業" }),
    ]);
    const jsx = await IncomesPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(screen.getByText("¥350,000")).toBeInTheDocument();
    expect(screen.getByText(/2件/)).toBeInTheDocument();
    expect(screen.getByText("給与")).toBeInTheDocument();
    expect(screen.getByText("副業")).toBeInTheDocument();
    expect(screen.getByText("¥300,000")).toBeInTheDocument();
    expect(screen.getByText("¥50,000")).toBeInTheDocument();
  });

  it("『収入を追加』の見出しとフォームがある", async () => {
    listIncomesMock.mockResolvedValue([]);
    const jsx = await IncomesPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    const heading = screen.getByRole("heading", { name: "収入を追加" });
    expect(heading).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "収入を追加する" })).toBeInTheDocument();
  });

  it("フォームの対象月（hidden の yearMonth）は表示中の月と一致する", async () => {
    listIncomesMock.mockResolvedValue([]);
    const jsx = await IncomesPage({ searchParams: Promise.resolve({ month: "2026-07" }) });
    const { container } = render(jsx);

    const hidden = container.querySelector('input[name="yearMonth"]') as HTMLInputElement | null;
    expect(hidden?.value).toBe("2026-07");
  });

  it("ホームへ戻るリンクがある", async () => {
    listIncomesMock.mockResolvedValue([]);
    const jsx = await IncomesPage({ searchParams: Promise.resolve({}) });
    render(jsx);
    expect(screen.getByRole("link", { name: /ホーム/ })).toHaveAttribute("href", "/");
  });
});

describe("『受け取った月』の明示", () => {
  it("見出しに『受け取った』という語を含む", async () => {
    listIncomesMock.mockResolvedValue([]);
    const jsx = await IncomesPage({ searchParams: Promise.resolve({ month: "2026-08" }) });
    render(jsx);
    const heading = screen.getByRole("heading", { name: "2026年8月に受け取った収入" });
    const section = heading.closest("section");
    if (!section) throw new Error("見出しの <section> が見つかりません");
    expect(within(section as HTMLElement).getByText(/翌月の原資/)).toBeInTheDocument();
  });
});
