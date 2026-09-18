import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { listCategories } from "@/lib/categories";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";

import { createCategoryAction, moveCategoryAction } from "./actions";
import { CategoryCreateForm } from "./category-create-form";
import { CategoryList } from "./category-list";

export const metadata: Metadata = {
  title: "カテゴリの設定",
};

/**
 * カテゴリの一覧 + 新規追加。
 *
 * connection() でプリレンダリングを止める。この画面は常に DB の最新状態を出す必要があり、
 * ビルド時に DB へ接続させないため。
 */
export default async function CategoriesPage() {
  await connection();
  // proxy とは別に、ここで利用者IDを得てデータ層へ渡す（proxy はユーザーIDを渡せない）
  const userId = await requireUserId();
  const categories = await listCategories(prisma, userId);

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm underline underline-offset-4 opacity-70">
          ← ホーム
        </Link>
        <h1 className="text-xl font-bold">カテゴリ</h1>
        <p className="text-sm opacity-70">
          支出を分類する軸です。使わなくなったカテゴリは削除ではなく非表示にしてください。
        </p>
      </header>

      <CategoryList categories={categories} moveAction={moveCategoryAction} />

      <section className="flex flex-col gap-3 border-t border-black/10 pt-5 dark:border-white/15">
        <h2 className="text-base font-semibold">カテゴリを追加</h2>
        <CategoryCreateForm action={createCategoryAction} />
      </section>
    </main>
  );
}
