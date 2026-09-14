/**
 * シードの実行入口。`npx prisma db seed` から呼ばれる
 * （コマンドは prisma.config.ts の `migrations.seed` に登録している）。
 *
 * 投入内容そのものは src/lib/seed.ts にある。ここは接続と後始末だけを行う。
 */
import "dotenv/config";

import { createPrismaClient } from "@/lib/prisma";
import { seedDatabase } from "@/lib/seed";

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    const result = await seedDatabase(prisma);
    console.log(
      `seed 完了: カテゴリ ${result.categories.length} 件 / 払い出し先 ${result.paymentSources.length} 件`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
