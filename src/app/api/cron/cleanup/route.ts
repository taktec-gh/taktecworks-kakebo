import { runCleanup } from "@/lib/cleanup";
import { getCronSecret, isAuthorizedCronRequest } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

/**
 * 定期処理: 期限切れのデモユーザーと、保持期間を過ぎた記録を消す（docs/steps/pub-3.md 設計判断 5）。
 *
 * vercel.json の crons から1日1回 GET で呼ばれる。proxy のセッション確認は通らない
 * （src/lib/auth.ts の isPublicPath に**このパスだけ**を完全一致で入れてある）ので、ここで認証する。
 *
 * - 認証は `Authorization: Bearer <CRON_SECRET>`（src/lib/cron-auth.ts）。
 *   CRON_SECRET が未設定・空なら何もせず 401（fail closed）
 * - 失敗は 401 で、本文に理由を書かない
 * - 応答は件数だけの JSON。ユーザーIDやデータの中身を返さない・ログに出さない
 * - Route Handler の GET は既定でキャッシュされない（node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md）。
 *   さらにリクエストのヘッダを読むので、ビルド時に実行されることもない
 */
export async function GET(request: Request): Promise<Response> {
  const authorized = isAuthorizedCronRequest(
    request.headers.get("authorization"),
    getCronSecret(),
  );
  if (!authorized) {
    return new Response(null, { status: 401 });
  }

  try {
    const result = await runCleanup(prisma, new Date());
    return Response.json(result);
  } catch {
    // 例外の中身（接続先・値を含みうる）は出さない
    return new Response(null, { status: 500 });
  }
}
