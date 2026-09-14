import {
  CostType,
  PaymentSourceType,
  type Category,
  type PaymentSource,
  type PrismaClient,
} from "@/generated/prisma/client";

/**
 * 初期データ（プリセット）の定義と投入処理。
 *
 * CLI から実行する入口は prisma/seed.ts。ここには DB 接続を持たず、
 * 呼び出し側から PrismaClient を受け取る（テストから差し替えられるようにするため）。
 *
 * 投入は upsert で行い、何度実行しても結果が変わらない（冪等）。
 * すでに存在するレコードは更新しない。利用者が並べ替え・非表示・既定値を
 * 変更したあとに再実行しても、その変更を巻き戻さないため。
 */

export type PresetCategory = {
  name: string;
  costType: CostType;
  sortOrder: number;
};

export type PresetPaymentSource = {
  name: string;
  type: PaymentSourceType;
  sortOrder: number;
  isDefault: boolean;
};

/**
 * プリセットカテゴリ11件（features.md「初期カテゴリをプリセット」の順序）。
 *
 * costType は「毎月ほぼ同額が自動的に出ていくか」で分けている。
 * 家賃・光熱費・通信は契約に紐づき利用者が日々の意思決定で増減させられないため FIXED、
 * 残りは使い方次第で増減するため VARIABLE。
 */
export const PRESET_CATEGORIES: readonly PresetCategory[] = [
  { name: "食費", costType: CostType.VARIABLE, sortOrder: 1 },
  { name: "日用品", costType: CostType.VARIABLE, sortOrder: 2 },
  { name: "外食", costType: CostType.VARIABLE, sortOrder: 3 },
  { name: "交通", costType: CostType.VARIABLE, sortOrder: 4 },
  { name: "光熱費", costType: CostType.FIXED, sortOrder: 5 },
  { name: "通信", costType: CostType.FIXED, sortOrder: 6 },
  { name: "家賃", costType: CostType.FIXED, sortOrder: 7 },
  { name: "趣味", costType: CostType.VARIABLE, sortOrder: 8 },
  { name: "交際", costType: CostType.VARIABLE, sortOrder: 9 },
  { name: "医療", costType: CostType.VARIABLE, sortOrder: 10 },
  { name: "その他", costType: CostType.VARIABLE, sortOrder: 11 },
] as const;

/**
 * プリセットの払い出し先は「現金」1件のみ。
 * クレジットカード・銀行引き落としは利用者が自分の事情に合わせて登録するものなので
 * こちらでは作らない（features.md「ユーザーが自分の事情に合わせて任意の数だけ登録できる」）。
 */
export const PRESET_PAYMENT_SOURCES: readonly PresetPaymentSource[] = [
  { name: "現金", type: PaymentSourceType.CASH, sortOrder: 1, isDefault: true },
] as const;

export type SeedResult = {
  categories: Category[];
  paymentSources: PaymentSource[];
};

/**
 * プリセットを投入する。冪等。
 *
 * @param client 使用する PrismaClient
 * @returns 投入後のカテゴリ・払い出し先（プリセット分のみ、定義順）
 */
export async function seedDatabase(client: PrismaClient): Promise<SeedResult> {
  const categories: Category[] = [];
  for (const preset of PRESET_CATEGORIES) {
    const category = await client.category.upsert({
      where: { name: preset.name },
      update: {},
      create: {
        name: preset.name,
        costType: preset.costType,
        sortOrder: preset.sortOrder,
      },
    });
    categories.push(category);
  }

  const paymentSources: PaymentSource[] = [];
  for (const preset of PRESET_PAYMENT_SOURCES) {
    const paymentSource = await client.paymentSource.upsert({
      where: { name: preset.name },
      update: {},
      create: {
        name: preset.name,
        type: preset.type,
        sortOrder: preset.sortOrder,
        isDefault: preset.isDefault,
      },
    });
    paymentSources.push(paymentSource);
  }

  return { categories, paymentSources };
}
