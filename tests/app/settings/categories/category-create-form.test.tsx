// src/app/settings/categories/category-create-form.tsx の描画・操作を検証する。
//
// 選択肢の順序・既定値は src/lib/category-validation.ts の COST_TYPE_OPTIONS を
// そのまま使う実装なので、ハードコードした値ではなく実際の定数を根拠に検証する。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CostType } from "@/generated/prisma/enums";
import { CATEGORY_NAME_MAX_LENGTH, COST_TYPE_OPTIONS } from "@/lib/category-validation";
import { CategoryCreateForm } from "@/app/settings/categories/category-create-form";

const ERROR_MESSAGE = "名前を入力してください。";

const failingAction = () => ({ error: ERROR_MESSAGE });

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("名前") as HTMLInputElement;
}

function costTypeSelect(): HTMLSelectElement {
  return screen.getByLabelText("固定費 / 変動費") as HTMLSelectElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button") as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
});

describe("初期表示", () => {
  it("名前・固定費/変動費の入力欄がある", () => {
    render(<CategoryCreateForm action={failingAction} />);
    expect(nameInput()).toBeInTheDocument();
    expect(costTypeSelect()).toBeInTheDocument();
  });

  it("名前欄の name 属性・maxLength が仕様どおり（20文字）", () => {
    render(<CategoryCreateForm action={failingAction} />);
    expect(nameInput().name).toBe("name");
    expect(nameInput()).toHaveAttribute("maxLength", String(CATEGORY_NAME_MAX_LENGTH));
    expect(CATEGORY_NAME_MAX_LENGTH).toBe(20);
  });

  it("固定費/変動費の選択肢は COST_TYPE_OPTIONS のラベル順と一致する", () => {
    render(<CategoryCreateForm action={failingAction} />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(COST_TYPE_OPTIONS.map((o) => o.label));
  });

  it("既定選択は COST_TYPE_OPTIONS の先頭の値", () => {
    render(<CategoryCreateForm action={failingAction} />);
    expect(costTypeSelect().value).toBe(COST_TYPE_OPTIONS[0]?.value);
  });

  it("エラーは表示されていない", () => {
    render(<CategoryCreateForm action={failingAction} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("送信ボタンは押せる状態", () => {
    render(<CategoryCreateForm action={failingAction} />);
    expect(submitButton()).toBeEnabled();
  });
});

describe("送信", () => {
  it("入力した名前と costType が FormData として action に渡る", async () => {
    const action = vi.fn((_prev: { error: string | null }, formData: FormData) => ({
      error: null,
    }));
    render(<CategoryCreateForm action={action} />);

    fireEvent.change(nameInput(), { target: { value: "保険" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0][1];
    expect(formData.get("name")).toBe("保険");
    expect(formData.get("costType")).toBe(COST_TYPE_OPTIONS[0]?.value);
  });
});

describe("失敗時の表示", () => {
  it("エラーメッセージが role=alert で表示される", async () => {
    render(<CategoryCreateForm action={failingAction} />);
    fireEvent.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(ERROR_MESSAGE);
  });

  it("入力欄に aria-invalid が付く", async () => {
    render(<CategoryCreateForm action={failingAction} />);
    fireEvent.click(submitButton());

    await screen.findByRole("alert");
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
  });
});

describe("送信中", () => {
  it("ボタンが「追加中…」になり無効化され、完了すると戻る", async () => {
    let resolveAction: (state: { error: string | null }) => void = () => {};
    const action = () =>
      new Promise<{ error: string | null }>((resolve) => {
        resolveAction = resolve;
      });

    render(<CategoryCreateForm action={action} />);
    fireEvent.click(submitButton());

    await waitFor(() => expect(submitButton()).toBeDisabled());
    expect(submitButton()).toHaveTextContent("追加中…");

    resolveAction({ error: null });

    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(submitButton()).toHaveTextContent("追加する");
  });
});

// 退行テスト: docs/steps/fix-form-reset-select.md（コミット 617e6cb）。
//
// React 19 の <form action={関数}> は完了時に必ず form.reset() を実行し、<select> の
// defaultSelected はマウント時にしか書かれないため、対策なしだと「先頭以外の costType を選んで
// 追加に失敗 → 名前だけ直して再送信」で2回目の costType が先頭の選択肢（VARIABLE）に巻き戻る。
// 2回目の送信の FormData を見ないとこの不具合は再現しないため、2回目の送信内容を検証する。
//
// 「追加に成功したあと <select> が先頭に戻る」テストは書かない（指示書で意図的な挙動と確定済み）。
describe("<select> のリセット対策（フォーム自動リセットでの巻き戻り防止）", () => {
  it("失敗パス: 先頭以外の costType を選んで送信失敗 → 名前だけ直して再送信しても、選んだ costType が送られる", async () => {
    const seen: string[] = [];
    const action = (_prev: { error: string | null }, formData: FormData) => {
      seen.push(String(formData.get("costType")));
      return { error: ERROR_MESSAGE };
    };
    render(<CategoryCreateForm action={action} />);

    fireEvent.change(nameInput(), { target: { value: "保険" } });
    fireEvent.change(costTypeSelect(), { target: { value: CostType.FIXED } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(seen.length).toBe(1));
    expect(seen[0]).toBe(CostType.FIXED);

    // 根拠: action はエラーを返しているだけで完了はしているため reset() は走る。
    // <select> の表示も、選んだ FIXED のままであるべき（先頭の VARIABLE に戻ってはいけない）。
    expect(costTypeSelect().value).toBe(CostType.FIXED);

    fireEvent.change(nameInput(), { target: { value: "保険(訂正)" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(seen.length).toBe(2));

    // 根拠: 利用者は costType を選び直していないので、2回目も FIXED が送られるべき
    // （マウント時の先頭の選択肢 VARIABLE に巻き戻ってはいけない）。
    expect(seen[1]).toBe(CostType.FIXED);
  });
});
