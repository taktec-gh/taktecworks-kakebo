"use client";

import { useActionState, useState } from "react";

import {
  CATEGORY_NAME_MAX_LENGTH,
  COST_TYPE_OPTIONS,
  isCostType,
} from "@/lib/category-validation";

import { initialCategoryActionState, type CategoryFormAction } from "./action-state";

export type CategoryCreateFormProps = {
  /** 通常は Server Action の createCategoryAction を渡す */
  action: CategoryFormAction;
};

/**
 * カテゴリの追加フォーム。
 * 入力は名前と固定費/変動費の2つだけ。sortOrder は末尾、追加直後は表示中。
 */
export function CategoryCreateForm({ action }: CategoryCreateFormProps) {
  const [state, formAction, pending] = useActionState(action, initialCategoryActionState);

  // 固定費 / 変動費の選択値を state で持ち、それを <select> の key と defaultValue の両方に渡す。
  //
  // React 19 の <form action={関数}> は、アクション完了時に必ずネイティブの form.reset() を
  // 実行する。reset() は <select> を defaultSelected へ戻すが、**React は defaultSelected を
  // マウント時にしか書かない**ため、defaultValue を渡していてもマウント時の値（＝先頭の
  // 選択肢「変動費」）へ巻き戻る（docs/tech-stack.md 参照）。
  //
  // 実害: 名前が重複して追加に失敗したとき（アクションは完了しているので reset() は走る）、
  // 固定費 / 変動費だけが先頭の選択肢に戻る。利用者が名前を直して押し直すと、意図と違う
  // 種別で作られる。
  //
  // key が変わると <select> が作り直され、マウント時の defaultSelected が現在の選択値になる。
  //
  // 挙動の変更点（意図的）: 追加に成功したあとも <select> は先頭に戻らず、直前に選んだ値の
  // ままになる。CategoryActionState は { error } しか持たず「成功した」ことを画面側から
  // 判別できないため。固定費をまとめて登録する場面ではむしろ都合が良い。
  const [selectedCostType, setSelectedCostType] = useState(COST_TYPE_OPTIONS[0]?.value);

  return (
    <form action={formAction} className="flex w-full flex-col gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-category-name" className="text-sm font-medium">
          名前
        </label>
        {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
        <input
          id="new-category-name"
          name="name"
          type="text"
          required
          maxLength={CATEGORY_NAME_MAX_LENGTH}
          enterKeyHint="done"
          placeholder="例: 保険"
          aria-describedby={state.error ? "create-category-error" : undefined}
          aria-invalid={state.error ? true : undefined}
          className="h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-category-cost-type" className="text-sm font-medium">
          固定費 / 変動費
        </label>
        <select
          key={selectedCostType}
          id="new-category-cost-type"
          name="costType"
          defaultValue={selectedCostType}
          onChange={(event) => {
            const { value } = event.target;
            if (isCostType(value)) setSelectedCostType(value);
          }}
          className="h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
        >
          {COST_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {state.error ? (
        <p id="create-category-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="h-12 w-full rounded-lg bg-foreground text-base font-medium text-background disabled:opacity-60"
      >
        {pending ? "追加中…" : "追加する"}
      </button>
    </form>
  );
}
