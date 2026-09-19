import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { formatYen } from "@/lib/budget-calculation";
import { listCategories } from "@/lib/categories";
import { formatDateFullLabel, fromDbDate } from "@/lib/expense-date";
import { listRecentStoreNames } from "@/lib/expenses";
import { getExpense } from "@/lib/expenses";
import { listPaymentSources } from "@/lib/payment-sources";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";

import { EXPENSES_PATH } from "../action-state";
import { deleteExpenseAction, updateExpenseAction } from "../actions";
import { ExpenseForm } from "../expense-form";
import { ExpenseDeleteForm } from "./expense-delete-form";

export const metadata: Metadata = {
  title: "支出の編集",
};

/**
 * 支出の編集・削除。
 *
 * 選択肢には通常「表示中のカテゴリ」「有効な払い出し先」だけを出すが、
 * **この支出が今使っているものは、非表示・無効でも必ず選択肢に残す。**
 * 残さないと、金額だけ直したいときにカテゴリが勝手に変わってしまう。
 */
export default async function ExpenseEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  // proxy とは別に、ここで利用者IDを得てデータ層へ渡す（proxy はユーザーIDを渡せない）
  const userId = await requireUserId();

  const { id } = await params;
  const expense = await getExpense(prisma, userId, id);
  if (!expense) notFound();

  const [categories, paymentSources, storeNameSuggestions] = await Promise.all([
    listCategories(prisma, userId),
    listPaymentSources(prisma, userId),
    listRecentStoreNames(prisma, userId),
  ]);

  const selectableCategories = categories.filter(
    (category) => !category.isHidden || category.id === expense.categoryId,
  );
  const selectablePaymentSources = paymentSources.filter(
    (source) => source.isActive || source.id === expense.paymentSourceId,
  );

  const date = fromDbDate(expense.date);
  const description = `${formatDateFullLabel(date)} ${expense.category.name} ${formatYen(expense.amountYen)}`;

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-6">
      <header className="flex flex-col gap-2">
        <Link href={EXPENSES_PATH} className="text-sm underline underline-offset-4 opacity-70">
          ← 支出一覧
        </Link>
        <h1 className="text-xl font-bold">支出の編集</h1>
        <p className="text-sm opacity-70 break-words">{description}</p>
      </header>

      <ExpenseForm
        mode="edit"
        expenseId={expense.id}
        categories={selectableCategories.map((category) => ({
          id: category.id,
          name: category.name,
        }))}
        // 編集画面では「よく使う」の枠を出さない。今ついているカテゴリを見せるのが先で、
        // 同じカテゴリが2箇所に並ぶと選択状態が読み取りづらくなるため
        quickPickCategoryIds={[]}
        paymentSources={selectablePaymentSources.map((source) => ({
          id: source.id,
          name: source.name,
          type: source.type,
        }))}
        storeNameSuggestions={storeNameSuggestions}
        initialValues={{
          date,
          amount: String(expense.amountYen),
          categoryId: expense.categoryId,
          paymentSourceId: expense.paymentSourceId,
          wasteTag: expense.wasteTag,
          storeName: expense.storeName ?? "",
          memo: expense.memo ?? "",
        }}
        action={updateExpenseAction}
      />

      <ExpenseDeleteForm
        id={expense.id}
        description={description}
        action={deleteExpenseAction}
      />
    </main>
  );
}
