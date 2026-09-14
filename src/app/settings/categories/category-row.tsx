"use client";

import Link from "next/link";
import { useActionState } from "react";

import type { CostType } from "@/generated/prisma/enums";
import { COST_TYPE_LABELS } from "@/lib/category-validation";

import {
  categoryDetailPath,
  initialCategoryActionState,
  type CategoryFormAction,
} from "./action-state";

export type CategoryRowProps = {
  id: string;
  name: string;
  costType: CostType;
  isHidden: boolean;
  /** グループ（表示/非表示）の中で上へ動かせるか */
  canMoveUp: boolean;
  /** グループの中で下へ動かせるか */
  canMoveDown: boolean;
  /** 通常は Server Action の moveCategoryAction を渡す */
  moveAction: CategoryFormAction;
};

/**
 * 一覧の1行。
 *
 * 名前部分をタップすると編集ページへ移動する（一覧にインライン編集を詰めると
 * スマホでタップ対象が小さくなるため）。並べ替えはドラッグではなく上へ/下へボタン。
 */
export function CategoryRow({
  id,
  name,
  costType,
  isHidden,
  canMoveUp,
  canMoveDown,
  moveAction,
}: CategoryRowProps) {
  const [state, formAction, pending] = useActionState(moveAction, initialCategoryActionState);

  return (
    <li className="rounded-xl border border-black/15 dark:border-white/20">
      <div className="flex items-stretch">
        <Link
          href={categoryDetailPath(id)}
          className="flex min-w-0 flex-1 flex-col justify-center gap-1 rounded-l-xl px-3 py-3"
        >
          <span className="text-base font-medium break-words">{name}</span>
          <span className="flex flex-wrap items-center gap-1 text-xs">
            <span className="rounded-full bg-black/8 px-2 py-0.5 dark:bg-white/15">
              {COST_TYPE_LABELS[costType]}
            </span>
            {isHidden ? (
              <span className="rounded-full bg-black/8 px-2 py-0.5 opacity-70 dark:bg-white/15">
                非表示
              </span>
            ) : null}
          </span>
        </Link>

        <form action={formAction} className="flex shrink-0 items-center gap-1 pr-2">
          <input type="hidden" name="id" value={id} />
          <button
            type="submit"
            name="direction"
            value="up"
            disabled={!canMoveUp || pending}
            aria-label={`${name} を上へ移動`}
            className="h-11 w-11 rounded-lg border border-black/15 text-lg leading-none disabled:opacity-30 dark:border-white/20"
          >
            ↑
          </button>
          <button
            type="submit"
            name="direction"
            value="down"
            disabled={!canMoveDown || pending}
            aria-label={`${name} を下へ移動`}
            className="h-11 w-11 rounded-lg border border-black/15 text-lg leading-none disabled:opacity-30 dark:border-white/20"
          >
            ↓
          </button>
        </form>
      </div>

      {state.error ? (
        <p role="alert" className="px-3 pb-3 text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </li>
  );
}
