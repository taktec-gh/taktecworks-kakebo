// src/app/incomes/income-form.tsx の描画・操作を検証する。
//
// 期待値の根拠:
// - docs/steps/step-6.md「tester への引き継ぎ」
//   「IncomeForm: 保存成功（savedCount の増加）で金額とラベルがクリアされる /
//    保存失敗（error）では入力が残る / yearMonth が hidden で送られる」
// - docs/steps/step-6.md「tester への引き継ぎ > name / id / 主なラベル文言」
//   （金額: name=amount id=income-amount、ラベル: name=label id=income-label、
//    送信: 収入を追加する / 保存中…）
// - docs/tech-stack.md「React 19 の <form action> はフォームを自動リセットする」対策
//   （text 入力なので巻き戻りは起きない設計。savedCount の変化でのみクリアする）

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IncomeForm } from "@/app/incomes/income-form";
import { initialIncomeActionState, type IncomeActionState } from "@/app/incomes/action-state";

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("金額・ラベルの入力欄がラベル文言つきである", () => {
    render(<IncomeForm yearMonth="2026-08" action={(prevState) => prevState} />);
    expect(screen.getByLabelText("金額")).toBeInTheDocument();
    expect(screen.getByLabelText("ラベル（任意）")).toBeInTheDocument();
  });

  it("金額欄は inputMode='numeric'", () => {
    render(<IncomeForm yearMonth="2026-08" action={(prevState) => prevState} />);
    expect(screen.getByLabelText("金額")).toHaveAttribute("inputMode", "numeric");
  });

  it("id は income-amount / income-label", () => {
    const { container } = render(
      <IncomeForm yearMonth="2026-08" action={(prevState) => prevState} />,
    );
    expect(container.querySelector("#income-amount")).toBeInTheDocument();
    expect(container.querySelector("#income-label")).toBeInTheDocument();
  });

  it("yearMonth が hidden フィールドとして埋め込まれる", () => {
    const { container } = render(
      <IncomeForm yearMonth="2026-08" action={(prevState) => prevState} />,
    );
    const hidden = container.querySelector('input[name="yearMonth"]') as HTMLInputElement;
    expect(hidden.type).toBe("hidden");
    expect(hidden.value).toBe("2026-08");
  });

  it("受け取った月であることを明示する文言がある", () => {
    render(<IncomeForm yearMonth="2026-08" action={(prevState) => prevState} />);
    expect(screen.getByText(/2026年8月に/)).toBeInTheDocument();
    expect(screen.getByText(/受け取った/)).toBeInTheDocument();
  });

  it("送信ボタンの文言は『収入を追加する』", () => {
    render(<IncomeForm yearMonth="2026-08" action={(prevState) => prevState} />);
    expect(screen.getByRole("button", { name: "収入を追加する" })).toBeInTheDocument();
  });
});

describe("金額のエラー表示", () => {
  it("未入力ならエラーを出さない", () => {
    render(<IncomeForm yearMonth="2026-08" action={(prevState) => prevState} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("0円を入力すると『1円以上』のエラーが出る", () => {
    render(<IncomeForm yearMonth="2026-08" action={(prevState) => prevState} />);
    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "0" } });
    expect(screen.getByRole("alert")).toHaveTextContent("1円以上");
  });

  it("正しい金額なら整形した円表示が出る", () => {
    render(<IncomeForm yearMonth="2026-08" action={(prevState) => prevState} />);
    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "300000" } });
    expect(screen.getByText("¥300,000")).toBeInTheDocument();
  });
});

describe("送信内容", () => {
  it("フォーム送信時、入力した金額・ラベルが action に渡る", async () => {
    const action = vi.fn(
      async (prevState: IncomeActionState, _formData: FormData): Promise<IncomeActionState> => ({
        error: null,
        savedCount: prevState.savedCount + 1,
      }),
    );
    render(<IncomeForm yearMonth="2026-08" action={action} />);

    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "300000" } });
    fireEvent.change(screen.getByLabelText("ラベル（任意）"), { target: { value: "給与" } });
    fireEvent.click(screen.getByRole("button", { name: "収入を追加する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0]?.[1];
    if (!formData) throw new Error("action に formData が渡っていません");
    expect(formData.get("amount")).toBe("300000");
    expect(formData.get("label")).toBe("給与");
    expect(formData.get("yearMonth")).toBe("2026-08");
  });

  it("エラーが返るとメッセージが alert で表示される", async () => {
    const action = async (prevState: IncomeActionState): Promise<IncomeActionState> => ({
      error: "金額を入力してください。",
      savedCount: prevState.savedCount,
    });
    render(<IncomeForm yearMonth="2026-08" action={action} />);

    fireEvent.click(screen.getByRole("button", { name: "収入を追加する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("金額を入力してください。");
  });
});

describe("保存成功でのクリア / 失敗時に残る", () => {
  it("保存成功（savedCount 増加）で金額とラベルがクリアされる", async () => {
    const action = vi.fn(
      async (prevState: IncomeActionState): Promise<IncomeActionState> => ({
        error: null,
        savedCount: prevState.savedCount + 1,
      }),
    );
    render(<IncomeForm yearMonth="2026-08" action={action} />);

    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "300000" } });
    fireEvent.change(screen.getByLabelText("ラベル（任意）"), { target: { value: "給与" } });
    fireEvent.click(screen.getByRole("button", { name: "収入を追加する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect((screen.getByLabelText("金額") as HTMLInputElement).value).toBe("");
    });
    expect((screen.getByLabelText("ラベル（任意）") as HTMLInputElement).value).toBe("");
  });

  it("『保存しました』のメッセージが出る", async () => {
    const action = vi.fn(
      async (prevState: IncomeActionState): Promise<IncomeActionState> => ({
        error: null,
        savedCount: prevState.savedCount + 1,
      }),
    );
    render(<IncomeForm yearMonth="2026-08" action={action} />);

    fireEvent.click(screen.getByRole("button", { name: "収入を追加する" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("保存しました。");
  });

  it("保存失敗（error が返る）では入力が残る", async () => {
    const action = vi.fn(
      async (prevState: IncomeActionState): Promise<IncomeActionState> => ({
        error: "対象月の指定が不正です。",
        savedCount: prevState.savedCount,
      }),
    );
    render(<IncomeForm yearMonth="2026-08" action={action} />);

    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "300000" } });
    fireEvent.change(screen.getByLabelText("ラベル（任意）"), { target: { value: "給与" } });
    fireEvent.click(screen.getByRole("button", { name: "収入を追加する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await screen.findByRole("alert");

    expect((screen.getByLabelText("金額") as HTMLInputElement).value).toBe("300000");
    expect((screen.getByLabelText("ラベル（任意）") as HTMLInputElement).value).toBe("給与");
  });

  it("2件連続で保存すると、そのたびにクリアが走る", async () => {
    const action = vi.fn(
      async (prevState: IncomeActionState): Promise<IncomeActionState> => ({
        error: null,
        savedCount: prevState.savedCount + 1,
      }),
    );
    render(<IncomeForm yearMonth="2026-08" action={action} />);

    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "100000" } });
    fireEvent.click(screen.getByRole("button", { name: "収入を追加する" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect((screen.getByLabelText("金額") as HTMLInputElement).value).toBe("");
    });

    fireEvent.change(screen.getByLabelText("金額"), { target: { value: "200000" } });
    fireEvent.click(screen.getByRole("button", { name: "収入を追加する" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect((screen.getByLabelText("金額") as HTMLInputElement).value).toBe("");
    });
  });
});

describe("初期状態（initialIncomeActionState）", () => {
  it("error: null, savedCount: 0", () => {
    expect(initialIncomeActionState).toEqual({ error: null, savedCount: 0 });
  });
});
