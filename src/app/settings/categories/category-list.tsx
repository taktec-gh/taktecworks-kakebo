import type { CostType } from "@/generated/prisma/enums";
import { canMoveCategory, sortCategories, type CategoryOrderItem } from "@/lib/category-order";

import type { CategoryFormAction } from "./action-state";
import { CategoryRow } from "./category-row";

/** 一覧表示に必要な項目。Prisma の Category はこれを満たす */
export type CategoryListItem = CategoryOrderItem & {
  name: string;
  costType: CostType;
};

export type CategoryListProps = {
  categories: readonly CategoryListItem[];
  /** 通常は Server Action の moveCategoryAction を渡す */
  moveAction: CategoryFormAction;
};

/**
 * カテゴリの一覧。
 * 「表示」グループ → 「非表示」グループの順に並べ、各グループ内は sortOrder 昇順。
 * 移動は同一グループ内のみで、端では該当ボタンを非活性にする。
 */
export function CategoryList({ categories, moveAction }: CategoryListProps) {
  const sorted = sortCategories(categories);
  const visible = sorted.filter((category) => !category.isHidden);
  const hidden = sorted.filter((category) => category.isHidden);

  if (sorted.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-black/20 px-4 py-6 text-center text-sm opacity-70 dark:border-white/25">
        カテゴリがまだありません。下のフォームから追加してください。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold opacity-70">表示中</h2>
        {visible.length === 0 ? (
          <p className="text-sm opacity-70">
            表示中のカテゴリがありません。支出の記録には最低1件必要です。
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {visible.map((category) => (
              <CategoryRow
                key={category.id}
                id={category.id}
                name={category.name}
                costType={category.costType}
                isHidden={category.isHidden}
                canMoveUp={canMoveCategory(sorted, category.id, "up")}
                canMoveDown={canMoveCategory(sorted, category.id, "down")}
                moveAction={moveAction}
              />
            ))}
          </ul>
        )}
      </section>

      {hidden.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold opacity-70">非表示</h2>
          <ul className="flex flex-col gap-2">
            {hidden.map((category) => (
              <CategoryRow
                key={category.id}
                id={category.id}
                name={category.name}
                costType={category.costType}
                isHidden={category.isHidden}
                canMoveUp={canMoveCategory(sorted, category.id, "up")}
                canMoveDown={canMoveCategory(sorted, category.id, "down")}
                moveAction={moveAction}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
