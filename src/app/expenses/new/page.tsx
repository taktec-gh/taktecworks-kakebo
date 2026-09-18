import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { listCategories } from "@/lib/categories";
import { getCurrentDate } from "@/lib/expense-date";
import { DEFAULT_WASTE_TAG } from "@/lib/expense-validation";
import { listQuickPickCategoryIds, listRecentStoreNames } from "@/lib/expenses";
import { listPaymentSources } from "@/lib/payment-sources";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";

import { CATEGORIES_PATH } from "../../settings/categories/action-state";
import { PAYMENT_SOURCES_PATH } from "../../settings/payment-sources/action-state";
import { EXPENSES_PATH } from "../action-state";
import { createExpenseAction } from "../actions";
import { ExpenseForm } from "../expense-form";

export const metadata: Metadata = {
  title: "支出を記録",
};

/**
 * 支出の登録。**アプリで最も使う画面。**
 *
 * 初期値は「日付 = 今日(JST)」「払い出し先 = 既定」「浪費フラグ = 必要」で、
 * 通常は金額とカテゴリだけ触れば保存できる（docs/steps/step-5.md）。
 *
 * 登録できない状態（有効な払い出し先が0件 / 表示中のカテゴリが0件）のときは
 * エラーで落とさず、設定画面への案内を出す。
 *
 * connection() でプリレンダリングを止める。この画面は常に DB の最新状態を出す必要があり、
 * ビルド時に DB へ接続させないため。
 */
export default async function NewExpensePage() {
  await connection();
  // proxy とは別に、ここで利用者IDを得てデータ層へ渡す（proxy はユーザーIDを渡せない）
  const userId = await requireUserId();

  const now = new Date();
  const [categories, paymentSources] = await Promise.all([
    listCategories(prisma, userId),
    listPaymentSources(prisma, userId),
  ]);

  const visibleCategories = categories.filter((category) => !category.isHidden);
  const activePaymentSources = paymentSources.filter((source) => source.isActive);

  const [quickPickCategoryIds, storeNameSuggestions] = await Promise.all([
    listQuickPickCategoryIds(
      prisma,
      userId,
      visibleCategories.map((category) => category.id),
      now,
    ),
    listRecentStoreNames(prisma, userId),
  ]);

  // 既定が無効化されている等の異常時も入力できるよう、先頭へ落とす
  const defaultPaymentSource =
    activePaymentSources.find((source) => source.isDefault) ?? activePaymentSources[0];

  const blocked =
    activePaymentSources.length === 0
      ? {
          message: "有効な払い出し先がありません。先に払い出し先を登録してください。",
          href: PAYMENT_SOURCES_PATH,
          linkLabel: "払い出し先の設定へ",
        }
      : visibleCategories.length === 0
        ? {
            message: "表示中のカテゴリがありません。先にカテゴリを追加するか、非表示を戻してください。",
            href: CATEGORIES_PATH,
            linkLabel: "カテゴリの設定へ",
          }
        : null;

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-6">
      <header className="flex flex-col gap-2">
        <Link href="/" className="text-sm underline underline-offset-4 opacity-70">
          ← ホーム
        </Link>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-bold">支出を記録</h1>
          <Link href={EXPENSES_PATH} className="text-sm underline underline-offset-4 opacity-70">
            支出一覧
          </Link>
        </div>
      </header>

      {blocked ? (
        <section className="flex flex-col gap-3 rounded-xl border border-dashed border-black/20 px-4 py-6 dark:border-white/25">
          <p className="text-sm">{blocked.message}</p>
          <Link
            href={blocked.href}
            className="flex h-12 w-full items-center justify-center rounded-lg bg-foreground text-base font-medium text-background"
          >
            {blocked.linkLabel}
          </Link>
        </section>
      ) : (
        <ExpenseForm
          mode="create"
          categories={visibleCategories.map((category) => ({
            id: category.id,
            name: category.name,
          }))}
          quickPickCategoryIds={quickPickCategoryIds}
          paymentSources={activePaymentSources.map((source) => ({
            id: source.id,
            name: source.name,
            type: source.type,
          }))}
          storeNameSuggestions={storeNameSuggestions}
          initialValues={{
            date: getCurrentDate(now),
            amount: "",
            categoryId: "",
            paymentSourceId: defaultPaymentSource?.id ?? "",
            wasteTag: DEFAULT_WASTE_TAG,
            storeName: "",
            memo: "",
          }}
          action={createExpenseAction}
        />
      )}
    </main>
  );
}
