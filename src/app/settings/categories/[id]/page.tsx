import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { getCategoryDeleteBlockedReason, getCategoryDetail } from "@/lib/categories";
import { COST_TYPE_LABELS } from "@/lib/category-validation";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";

import { CATEGORIES_PATH } from "../action-state";
import {
  deleteCategoryAction,
  setCategoryHiddenAction,
  updateCategoryAction,
} from "../actions";
import { CategoryEditForm } from "./category-edit-form";

export const metadata: Metadata = {
  title: "カテゴリの編集",
};

/**
 * カテゴリの編集。
 * 「削除できるか」は参照件数で決まるため、サーバー側で理由を求めて画面に渡す。
 * 実行時は Server Action 側でも再判定する。
 */
export default async function CategoryEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  // proxy とは別に、ここで利用者IDを得てデータ層へ渡す（proxy はユーザーIDを渡せない）
  const userId = await requireUserId();
  const { id } = await params;
  const detail = await getCategoryDetail(prisma, userId, id);
  if (!detail) notFound();

  const { category } = detail;

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <Link href={CATEGORIES_PATH} className="text-sm underline underline-offset-4 opacity-70">
          ← カテゴリの一覧
        </Link>
        <h1 className="text-xl font-bold break-words">{category.name}</h1>
        <p className="text-sm opacity-70">
          {COST_TYPE_LABELS[category.costType]}
          {category.isHidden ? " / 非表示" : ""}
        </p>
      </header>

      <CategoryEditForm
        id={category.id}
        name={category.name}
        costType={category.costType}
        isHidden={category.isHidden}
        deleteBlockedReason={getCategoryDeleteBlockedReason(detail)}
        updateAction={updateCategoryAction}
        setHiddenAction={setCategoryHiddenAction}
        deleteAction={deleteCategoryAction}
      />
    </main>
  );
}
