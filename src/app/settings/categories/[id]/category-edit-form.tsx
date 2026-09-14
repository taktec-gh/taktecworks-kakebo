"use client";

import { useActionState, useState } from "react";

import type { CostType } from "@/generated/prisma/enums";
import {
  CATEGORY_NAME_MAX_LENGTH,
  COST_TYPE_OPTIONS,
  isCostType,
} from "@/lib/category-validation";

import { initialCategoryActionState, type CategoryFormAction } from "../action-state";

export type CategoryEditFormProps = {
  id: string;
  name: string;
  costType: CostType;
  isHidden: boolean;
  /** 削除できない理由。できるなら null */
  deleteBlockedReason: string | null;
  /** 通常は Server Action の updateCategoryAction */
  updateAction: CategoryFormAction;
  /** 通常は Server Action の setCategoryHiddenAction */
  setHiddenAction: CategoryFormAction;
  /** 通常は Server Action の deleteCategoryAction */
  deleteAction: CategoryFormAction;
};

const fieldClass =
  "h-12 w-full rounded-lg border border-black/20 bg-white px-3 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70";

const secondaryButtonClass =
  "h-12 w-full rounded-lg border border-black/20 text-base font-medium disabled:opacity-40 dark:border-white/25";

/**
 * カテゴリの編集。
 *
 * 操作ごとに form を分ける（リネーム/属性変更・非表示/再表示・削除）。
 * 実行できない操作はボタンを非活性にし、理由をその場に出す。
 * 押せてしまった場合も Server Action 側が同じ理由で拒否する。
 */
export function CategoryEditForm({
  id,
  name,
  costType,
  isHidden,
  deleteBlockedReason,
  updateAction,
  setHiddenAction,
  deleteAction,
}: CategoryEditFormProps) {
  const [updateState, updateFormAction, updatePending] = useActionState(
    updateAction,
    initialCategoryActionState,
  );
  const [hiddenState, hiddenFormAction, hiddenPending] = useActionState(
    setHiddenAction,
    initialCategoryActionState,
  );
  const [deleteState, deleteFormAction, deletePending] = useActionState(
    deleteAction,
    initialCategoryActionState,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // 固定費 / 変動費の選択値を state で持ち、それを <select> の key と defaultValue の両方に渡す。
  //
  // React 19 の <form action={関数}> は、アクション完了時に必ずネイティブの form.reset() を
  // 実行する。reset() は各コントロールを defaultValue / defaultChecked / defaultSelected へ
  // 戻すが、**<select> の defaultSelected は React がマウント時にしか書かない**。
  // そのため defaultValue に今の値を渡していても、リセット後は「マウント時の値」へ巻き戻る
  // （text 入力は更新のたびに defaultValue が同期されるので実害がない。docs/tech-stack.md 参照）。
  //
  // 実害: 固定費 / 変動費を変えて保存 → 画面の表示は新しい値になるが DOM の defaultSelected は
  // 古いまま。名前だけ直してもう一度保存すると、送信される costType が古い値に戻る。
  //
  // key が変わると <select> が作り直され、マウント時の defaultSelected が現在の選択値になる。
  // 以後の reset() は実質何もしなくなる。
  //
  // key に props の costType や保存回数の世代番号を使ってはいけない。保存が名前の重複などで
  // 失敗したときにどちらも動かず（または元の値に戻り）、利用者が選び直した未保存の値を
  // 黙って捨てることになる。これは今直している不具合と同じ形。
  const [selectedCostType, setSelectedCostType] = useState(costType);

  // サーバーから来た値が変わったら state を追従させる。
  // レンダー中に前回の props と比べて調整する（expense-form.tsx の handledSavedCount と同じ書き方。
  // useEffect で書くと一度古い値を描いてから再描画することになる）。
  const [lastCostType, setLastCostType] = useState(costType);
  if (lastCostType !== costType) {
    setLastCostType(costType);
    setSelectedCostType(costType);
  }

  return (
    <div className="flex flex-col gap-6">
      <form action={updateFormAction} className="flex flex-col gap-3" noValidate>
        <input type="hidden" name="id" value={id} />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="category-name" className="text-sm font-medium">
            名前
          </label>
          {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
          <input
            id="category-name"
            name="name"
            type="text"
            required
            defaultValue={name}
            maxLength={CATEGORY_NAME_MAX_LENGTH}
            enterKeyHint="done"
            aria-describedby={updateState.error ? "category-update-error" : undefined}
            aria-invalid={updateState.error ? true : undefined}
            className={fieldClass}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="category-cost-type" className="text-sm font-medium">
            固定費 / 変動費
          </label>
          <select
            key={selectedCostType}
            id="category-cost-type"
            name="costType"
            defaultValue={selectedCostType}
            onChange={(event) => {
              const { value } = event.target;
              if (isCostType(value)) setSelectedCostType(value);
            }}
            className={fieldClass}
          >
            {COST_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {updateState.error ? (
          <p
            id="category-update-error"
            role="alert"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {updateState.error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={updatePending}
          className="h-12 w-full rounded-lg bg-foreground text-base font-medium text-background disabled:opacity-60"
        >
          {updatePending ? "保存中…" : "保存する"}
        </button>
      </form>

      <section className="flex flex-col gap-3 border-t border-black/10 pt-5 dark:border-white/15">
        <h2 className="text-base font-semibold">このカテゴリの状態</h2>
        <p className="text-sm opacity-70">
          非表示にすると、支出の記録で選べなくなります。過去の支出はそのまま残ります。
        </p>

        <form action={hiddenFormAction} className="flex flex-col gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="isHidden" value={isHidden ? "false" : "true"} />
          <button type="submit" disabled={hiddenPending} className={secondaryButtonClass}>
            {hiddenPending ? "変更中…" : isHidden ? "再表示する" : "非表示にする"}
          </button>
          {hiddenState.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {hiddenState.error}
            </p>
          ) : null}
        </form>
      </section>

      <section className="flex flex-col gap-2 border-t border-black/10 pt-5 dark:border-white/15">
        <h2 className="text-base font-semibold">削除</h2>
        <p className="text-sm opacity-70">
          支出やカテゴリ予算が1件でも紐づいているカテゴリは削除できません。使わなくなった場合は非表示にしてください。
        </p>

        {confirmingDelete ? (
          <form action={deleteFormAction} className="flex flex-col gap-2">
            <input type="hidden" name="id" value={id} />
            <p className="text-sm font-medium">「{name}」を削除します。元に戻せません。</p>
            <button
              type="submit"
              disabled={deletePending}
              className="h-12 w-full rounded-lg bg-red-600 text-base font-medium text-white disabled:opacity-60"
            >
              {deletePending ? "削除中…" : "削除する"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className={secondaryButtonClass}
            >
              やめる
            </button>
            {deleteState.error ? (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {deleteState.error}
              </p>
            ) : null}
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={deleteBlockedReason !== null}
              className="h-12 w-full rounded-lg border border-red-600/60 text-base font-medium text-red-600 disabled:opacity-40 dark:text-red-400"
            >
              削除する
            </button>
            {deleteBlockedReason ? (
              <p className="text-sm opacity-70">{deleteBlockedReason}</p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
