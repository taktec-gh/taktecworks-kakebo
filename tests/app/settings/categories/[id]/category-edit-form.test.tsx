// src/app/settings/categories/[id]/category-edit-form.tsx の描画・操作を検証する。
//
// 「削除できるか」「非表示/再表示のラベル」の判定材料は props で渡されるため、
// ここでは「渡された値どおりに表示・活性状態が切り替わること」を確認する
// （実際の判定ロジックは src/lib/categories.ts 側。tests/lib/categories.test.ts で検証済み）。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CostType } from "@/generated/prisma/enums";
import { CategoryEditForm } from "@/app/settings/categories/[id]/category-edit-form";
import type { CategoryFormAction } from "@/app/settings/categories/action-state";

const okAction: CategoryFormAction = () => ({ error: null });

function baseProps() {
  return {
    id: "cat_1",
    name: "食費",
    costType: CostType.VARIABLE,
    isHidden: false,
    deleteBlockedReason: null,
    updateAction: okAction,
    setHiddenAction: okAction,
    deleteAction: okAction,
  };
}

afterEach(() => {
  cleanup();
});

describe("リネーム / 固定費・変動費変更フォーム", () => {
  it("名前・costType の初期値が渡された値になっている", () => {
    render(<CategoryEditForm {...baseProps()} />);
    expect((screen.getByLabelText("名前") as HTMLInputElement).value).toBe("食費");
    expect((screen.getByLabelText("固定費 / 変動費") as HTMLSelectElement).value).toBe(
      CostType.VARIABLE,
    );
  });

  it("保存すると id・name・costType が action に渡る", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<CategoryEditForm {...baseProps()} updateAction={action} />);

    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "外食" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("id")).toBe("cat_1");
    expect(formData.get("name")).toBe("外食");
  });

  it("失敗時はエラーが alert で表示される", async () => {
    const action = () => ({ error: "同じ名前のカテゴリがすでに登録されています。" });
    render(<CategoryEditForm {...baseProps()} updateAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("同じ名前のカテゴリがすでに登録されています。");
  });
});

describe("非表示 / 再表示の切り替え", () => {
  it("表示中のときはボタンのラベルが「非表示にする」で、isHidden=true を送る", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<CategoryEditForm {...baseProps()} isHidden={false} setHiddenAction={action} />);

    const button = screen.getByRole("button", { name: "非表示にする" });
    fireEvent.click(button);

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("isHidden")).toBe("true");
    expect(action.mock.calls[0][1].get("id")).toBe("cat_1");
  });

  it("非表示のときはボタンのラベルが「再表示する」で、isHidden=false を送る", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<CategoryEditForm {...baseProps()} isHidden={true} setHiddenAction={action} />);

    const button = screen.getByRole("button", { name: "再表示する" });
    fireEvent.click(button);

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("isHidden")).toBe("false");
  });

  it("非表示にするボタンには「最後の1件は消せない」制限が無いため常に押せる", () => {
    render(<CategoryEditForm {...baseProps()} isHidden={false} />);
    expect(screen.getByRole("button", { name: "非表示にする" })).toBeEnabled();
  });

  it("失敗時はエラーが alert で表示される", async () => {
    const action = () => ({ error: "対象のカテゴリが見つかりません。" });
    render(<CategoryEditForm {...baseProps()} setHiddenAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "非表示にする" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("対象のカテゴリが見つかりません。");
  });
});

describe("削除", () => {
  it("拒否理由が無ければ「削除する」ボタンが押せ、押すと確認画面が出る", () => {
    render(<CategoryEditForm {...baseProps()} deleteBlockedReason={null} />);
    const button = screen.getByRole("button", { name: "削除する" });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(screen.getByText(/「食費」を削除します。元に戻せません。/)).toBeInTheDocument();
  });

  it("拒否理由がある場合（支出あり等）はボタンが非活性で理由が表示される", () => {
    const reason = "このカテゴリには支出が記録されているため削除できません。非表示にしてください。";
    render(<CategoryEditForm {...baseProps()} deleteBlockedReason={reason} />);
    expect(screen.getByRole("button", { name: "削除する" })).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it("確認画面で「やめる」を押すと確認前の表示に戻る", () => {
    render(<CategoryEditForm {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));

    expect(screen.queryByText(/元に戻せません/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "削除する" })).toBeInTheDocument();
  });

  it("確認画面で削除を確定すると id を含めて deleteAction が呼ばれる", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<CategoryEditForm {...baseProps()} deleteAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("id")).toBe("cat_1");
  });

  it("削除に失敗した場合はエラーが alert で表示される", async () => {
    const action = () => ({
      error: "このカテゴリにはカテゴリ予算が設定されているため削除できません。非表示にしてください。",
    });
    render(<CategoryEditForm {...baseProps()} deleteAction={action} />);

    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "このカテゴリにはカテゴリ予算が設定されているため削除できません。非表示にしてください。",
    );
  });
});

// 退行テスト: docs/steps/fix-form-reset-select.md（コミット 617e6cb）。
//
// React 19 の <form action={関数}> は完了時に必ず form.reset() を実行し、<select> の
// defaultSelected はマウント時にしか書かれないため、対策なしだと「costType を変えて保存 →
// もう一度保存」で送信内容が古い値（マウント時の値）に巻き戻る。
// 2回目の送信の FormData を見ないとこの不具合は再現しないため、すべてのケースで
// 2回目の送信内容を検証する。
describe("<select> のリセット対策（フォーム自動リセットでの巻き戻り防止）", () => {
  it("失敗パス: costType を変更 → 保存失敗 → 名前だけ直して再送信しても、変更後の costType が送られる", async () => {
    const seen: string[] = [];
    const action = (_prev: { error: string | null }, formData: FormData) => {
      seen.push(String(formData.get("costType")));
      return { error: "同じ名前のカテゴリがすでに登録されています。" };
    };
    render(
      <CategoryEditForm {...baseProps()} costType={CostType.VARIABLE} updateAction={action} />,
    );

    fireEvent.change(screen.getByLabelText("固定費 / 変動費"), {
      target: { value: CostType.FIXED },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toBe(CostType.FIXED);

    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "別の名前" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(seen.length).toBe(2));

    // 根拠: action はエラーを返しているだけで完了はしているため reset() は走る。
    // 利用者は costType を変え直していないので、2回目も直前に選んだ FIXED が
    // 送られるべき（マウント時の VARIABLE に巻き戻ってはいけない）。
    expect(seen[1]).toBe(CostType.FIXED);
  });

  it("成功パス: costType を変更して保存 → 新しい props が来る → 名前だけ直して再送信すると新しい costType が送られる", async () => {
    const seen: string[] = [];
    const action = (_prev: { error: string | null }, formData: FormData) => {
      seen.push(String(formData.get("costType")));
      return { error: null };
    };
    const { rerender } = render(
      <CategoryEditForm {...baseProps()} costType={CostType.VARIABLE} updateAction={action} />,
    );

    fireEvent.change(screen.getByLabelText("固定費 / 変動費"), {
      target: { value: CostType.FIXED },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(seen.length).toBe(1));

    // サーバーで保存され、新しい costType が props として返ってきた状況を rerender で再現
    rerender(
      <CategoryEditForm {...baseProps()} costType={CostType.FIXED} updateAction={action} />,
    );

    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "別の名前" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(seen.length).toBe(2));

    // 根拠: 1回目の保存で FIXED が確定し、props も FIXED に更新された。
    // 名前だけ変えて再送信しても FIXED が送られ続けるべき。
    expect(seen[1]).toBe(CostType.FIXED);
  });

  it("送信せず rerender で costType だけ変えると、<select> の表示値が新しい props に追従する", () => {
    const { rerender } = render(
      <CategoryEditForm {...baseProps()} costType={CostType.VARIABLE} />,
    );
    expect((screen.getByLabelText("固定費 / 変動費") as HTMLSelectElement).value).toBe(
      CostType.VARIABLE,
    );

    rerender(<CategoryEditForm {...baseProps()} costType={CostType.FIXED} />);

    // 根拠: サーバーから新しい props が来たら <select> はそれに追従すべき
    // （修正前は defaultValue だけだったため、マウント後の props 変化を反映しなかった）。
    expect((screen.getByLabelText("固定費 / 変動費") as HTMLSelectElement).value).toBe(
      CostType.FIXED,
    );
  });
});
