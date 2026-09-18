import type { PrismaClient } from "@/generated/prisma/client";

import { seedUserPresets } from "@/lib/seed";
import { brandUserIdFromTrustedSource, type UserId } from "@/lib/user-id";

/**
 * 利用者（User）の作成。
 *
 * **userId を取らない関数の例外**（docs/steps/pub-1.md 設計判断 6）。userId を生み出す側のため。
 * また、`brandUserIdFromTrustedSource` を呼んでよい3箇所の1つ（設計判断 7。サーバーが今作ったユーザー）。
 *
 * ユーザーIDを外部（フォーム・URL・Cookie）から受け取らない。ID は DB が採番する。
 */

/**
 * ユーザーを作り、同じトランザクションでプリセット（カテゴリ11件・払い出し先「現金」[既定]）を投入する。
 *
 * プリセットの投入に失敗したらユーザーも作られない（初期データの無いユーザーを残さない）。
 * サインアップ・デモアカウント作成の Step でそのまま使う想定（design-decisions.md 設計方針 2）。
 *
 * @returns 作成したユーザーの ID
 */
export async function createUserWithPresets(client: PrismaClient): Promise<UserId> {
  return client.$transaction(async (tx) => {
    const user = await tx.user.create({ data: {}, select: { id: true } });
    const userId = brandUserIdFromTrustedSource(user.id);
    await seedUserPresets(tx, userId);
    return userId;
  });
}
