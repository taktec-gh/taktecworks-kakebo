// src/app/expenses/expense-form.tsx の描画・操作を検証する。
//
// 期待値の根拠:
// - docs/steps/step-5.md「設計判断 > 登録後は入力画面に留まる」
//   「保存したら同じ画面に留まり、金額とカテゴリだけクリアして『保存しました』と出す。
//    日付・払い出し先・浪費フラグは直前の値を保つ」
// - docs/steps/step-5.md「実装完了後の引き継ぎ > 特に確認したい観点」12.
//   「savedCount が増えたとき create では金額とカテゴリのみクリアされ、日付・払い出し先・
//    浪費フラグ・店名・メモが保たれること。edit では何もクリアされないこと」
// - docs/steps/step-5.md「設計判断 > カテゴリは『よく使う順』を先頭に出す」
// - docs/steps/step-5.md「登録できない状態の案内」（カテゴリ0件・払い出し先0件の文言）

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaymentSourceType, WasteTag } from "@/generated/prisma/enums";
import { ExpenseForm, type ExpenseFormProps, type ExpenseFormValues } from "@/app/expenses/expense-form";
import type { ExpenseActionState } from "@/app/expenses/action-state";

const CATEGORIES = [
  { id: "cat_1", name: "食費" },
  { id: "cat_2", name: "日用品" },
  { id: "cat_3", name: "交通" },
];

const PAYMENT_SOURCES = [
  { id: "ps_1", name: "現金", type: PaymentSourceType.CASH },
  { id: "ps_2", name: "Aカード", type: PaymentSourceType.CREDIT_CARD },
];

function baseValues(overrides: Partial<ExpenseFormValues> = {}): ExpenseFormValues {
  return {
    date: "2026-08-13",
    amount: "500",
    categoryId: "cat_1",
    paymentSourceId: "ps_1",
    wasteTag: WasteTag.NECESSARY,
    storeName: "コンビニ",
    memo: "おやつ",
    ...overrides,
  };
}

function baseProps(overrides: Partial<ExpenseFormProps> = {}): ExpenseFormProps {
  return {
    mode: "create",
    categories: CATEGORIES,
    quickPickCategoryIds: [],
    paymentSources: PAYMENT_SOURCES,
    storeNameSuggestions: [],
    initialValues: baseValues(),
    action: (prevState: ExpenseActionState) => prevState,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("初期値どおりに各欄が表示される", () => {
    render(<ExpenseForm {...baseProps()} />);
    expect((screen.getByLabelText("金額") as HTMLInputElement).value).toBe("500");
    expect(screen.getByRole("radio", { name: "食費" })).toBeChecked();
    expect(screen.getByRole("radio", { name: /現金/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: "必要" })).toBeChecked();
  });

  it("金額欄は inputMode='numeric'（スマホで数字キーボードを出す）", () => {
    render(<ExpenseForm {...baseProps()} />);
    expect(screen.getByLabelText("金額")).toHaveAttribute("inputMode", "numeric");
  });

  it("create モードでは日付・店名・メモの詳細欄は既定で閉じている", () => {
    const { container } = render(<ExpenseForm {...baseProps({ mode: "create" })} />);
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("edit モードでは日付・店名・メモの詳細欄が既定で開いている", () => {
    const { container } = render(
      <ExpenseForm {...baseProps({ mode: "edit", expenseId: "exp_1" })} />,
    );
    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("edit モードでは id が hidden フィールドとして埋め込まれる", () => {
    const { container } = render(
      <ExpenseForm {...baseProps({ mode: "edit", expenseId: "exp_1" })} />,
    );
    const hidden = container.querySelector('input[name="id"]') as HTMLInputElement | null;
    expect(hidden?.value).toBe("exp_1");
  });

  it("保存ボタンの文言は create/edit で異なる", () => {
    cleanup();
    render(<ExpenseForm {...baseProps({ mode: "create" })} />);
    expect(screen.getByRole("button", { name: "保存する" })).toBeInTheDocument();
    cleanup();
    render(<ExpenseForm {...baseProps({ mode: "edit", expenseId: "exp_1" })} />);
    expect(screen.getByRole("button", { name: "変更を保存する" })).toBeInTheDocument();
  });
});

describe("金額のエラー表示", () => {
  it("金額が不正なら未入力ではないときだけエラーを表示する", () => {
    render(<ExpenseForm {...baseProps({ initialValues: baseValues({ amount: "" }) })} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("0円を入力すると『1円以上』のエラーが出る", () => {
    render(<ExpenseForm {...baseProps()} />);
    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "0" } });
    expect(screen.getByRole("alert")).toHaveTextContent("1円以上");
  });

  it("正しい金額なら整形した円表示が出る", () => {
    render(<ExpenseForm {...baseProps()} />);
    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "12345" } });
    expect(screen.getByText("¥12,345")).toBeInTheDocument();
  });
});

describe("カテゴリのクイック選択", () => {
  it("quickPickCategoryIds が空なら『よく使う』枠を出さない", () => {
    render(<ExpenseForm {...baseProps({ quickPickCategoryIds: [] })} />);
    expect(screen.queryByText("よく使う")).not.toBeInTheDocument();
  });

  it("quickPickCategoryIds があれば『よく使う』枠を出し、順序どおりに並ぶ", () => {
    render(<ExpenseForm {...baseProps({ quickPickCategoryIds: ["cat_2", "cat_1"] })} />);
    expect(screen.getByText("よく使う")).toBeInTheDocument();
    const quickButtons = screen.getAllByRole("button").filter((button) =>
      ["食費", "日用品"].includes(button.textContent ?? ""),
    );
    expect(quickButtons.map((button) => button.textContent)).toEqual(["日用品", "食費"]);
  });

  it("クイック選択を押すと通常のカテゴリ選択（ラジオ）が切り替わる", () => {
    render(
      <ExpenseForm
        {...baseProps({
          quickPickCategoryIds: ["cat_3"],
          initialValues: baseValues({ categoryId: "cat_1" }),
        })}
      />,
    );
    expect(screen.getByRole("radio", { name: "交通" })).not.toBeChecked();

    // クイック選択の「交通」ボタン（role=button）を押す
    const quickButton = screen.getAllByText("交通").find((el) => el.tagName === "BUTTON");
    fireEvent.click(quickButton!);

    expect(screen.getByRole("radio", { name: "交通" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "食費" })).not.toBeChecked();
  });
});

describe("登録できない状態の案内（フォーム内の文言）", () => {
  it("カテゴリが0件なら『表示中のカテゴリがありません。』を出す", () => {
    render(<ExpenseForm {...baseProps({ categories: [] })} />);
    expect(screen.getByText("表示中のカテゴリがありません。")).toBeInTheDocument();
  });

  it("payment source が0件なら『有効な払い出し先がありません。』を出す", () => {
    render(<ExpenseForm {...baseProps({ paymentSources: [] })} />);
    expect(screen.getByText("有効な払い出し先がありません。")).toBeInTheDocument();
  });
});

describe("送信内容", () => {
  it("フォーム送信時、選択中の値がすべて action に渡る", async () => {
    const action = vi.fn(
      async (prevState: ExpenseActionState, _formData: FormData) => ({
        error: null,
        savedCount: prevState.savedCount + 1,
      }),
    );
    render(<ExpenseForm {...baseProps({ action })} />);

    fireEvent.click(screen.getByRole("button", { name: "保存する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("amount")).toBe("500");
    expect(formData.get("categoryId")).toBe("cat_1");
    expect(formData.get("paymentSourceId")).toBe("ps_1");
    expect(formData.get("wasteTag")).toBe(WasteTag.NECESSARY);
    expect(formData.get("date")).toBe("2026-08-13");
    expect(formData.get("storeName")).toBe("コンビニ");
    expect(formData.get("memo")).toBe("おやつ");
  });

  it("エラーが返るとメッセージが alert で表示される", async () => {
    const action = async (prevState: ExpenseActionState) => ({
      error: "選択したカテゴリが見つかりません。",
      savedCount: prevState.savedCount,
    });
    render(<ExpenseForm {...baseProps({ action })} />);

    fireEvent.click(screen.getByRole("button", { name: "保存する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("選択したカテゴリが見つかりません。");
  });
});

describe("savedCount が増えたときのクリア（create / edit の違い）", () => {
  it("create モードでは金額とカテゴリだけがクリアされ、他は保たれる", async () => {
    const action = vi.fn(
      async (prevState: ExpenseActionState) => ({ error: null, savedCount: prevState.savedCount + 1 }),
    );
    render(<ExpenseForm {...baseProps({ mode: "create", action })} />);

    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    await waitFor(() => {
      expect((screen.getByLabelText("金額") as HTMLInputElement).value).toBe("");
    });
    // カテゴリはクリアされ、どのラジオも選択されていない
    // (docs/steps/step-5.md「savedCount が増えたとき create では金額とカテゴリのみ
    //  クリアされる」。React コンポーネントの values.categoryId は "" に正しくクリア
    //  されており、選択中のチップも視覚的には外れる。ただし <input type="radio"> の
    //  DOM の checked プロパティだけが古い値のまま残る場合がある。詳細は完了レポート参照）
    expect(screen.getByRole("radio", { name: "食費" })).not.toBeChecked();

    // 日付・払い出し先・浪費フラグ・店名・メモは保たれる
    expect(screen.getByRole("radio", { name: /現金/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: "必要" })).toBeChecked();
    const summary = screen.getByText("日付・店名・メモ");
    expect(summary).toHaveTextContent("2026/8/13(木)");
  });

  it("『保存しました』のメッセージが出る", async () => {
    const action = vi.fn(
      async (prevState: ExpenseActionState) => ({ error: null, savedCount: prevState.savedCount + 1 }),
    );
    render(<ExpenseForm {...baseProps({ mode: "create", action })} />);

    fireEvent.click(screen.getByRole("button", { name: "保存する" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("保存しました。");
  });

  it("2件連続で保存しても、savedCount が変わるたびにクリアが走る", async () => {
    const action = vi.fn(
      async (prevState: ExpenseActionState) => ({ error: null, savedCount: prevState.savedCount + 1 }),
    );
    render(<ExpenseForm {...baseProps({ mode: "create", action })} />);

    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect((screen.getByLabelText("金額") as HTMLInputElement).value).toBe("");
    });

    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "400" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect((screen.getByLabelText("金額") as HTMLInputElement).value).toBe("");
    });
  });

  it("edit モードでは savedCount が増えても何もクリアされない", async () => {
    const action = vi.fn(
      async (prevState: ExpenseActionState) => ({ error: null, savedCount: prevState.savedCount + 1 }),
    );
    render(<ExpenseForm {...baseProps({ mode: "edit", expenseId: "exp_1", action })} />);

    fireEvent.click(screen.getByRole("button", { name: "変更を保存する" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    // 金額もカテゴリも初期値のまま
    await screen.findByRole("status");
    expect((screen.getByLabelText("金額") as HTMLInputElement).value).toBe("500");
    expect(screen.getByRole("radio", { name: "食費" })).toBeChecked();
  });
});
