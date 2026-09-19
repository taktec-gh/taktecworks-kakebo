"use server";

import { redirect } from "next/navigation";

import { LOGIN_PATH } from "@/lib/auth";
import { getClientIpHash } from "@/lib/client-ip";
import { getDemoSessionMaxAgeSeconds } from "@/lib/demo-data";
import { isDemoRateLimited } from "@/lib/demo-limits";
import { DEMO_ERRORS, DEMO_START_PATH, type DemoActionState } from "@/lib/demo-messages";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession } from "@/lib/session";
import { createDemoUser, type CreateDemoUserResult } from "@/lib/users";

/**
 * ログアウトと、デモアカウントの開始。
 *
 * 公開版ではパスワードログインと緊急脱出モードを廃止した
 * （docs/steps/pub-1.md 設計判断 1）。ログインはパスキーのみで、passkey-actions.ts が担当する。
 */

/**
 * ログアウト。Cookie を破棄してログインページへ戻す。
 *
 * デモユーザーでも**ユーザーは消さない**（docs/steps/pub-3.md 設計判断 6）。
 * ログアウトの処理に「ユーザーを消す」経路を作らない。期限切れの削除（定期処理）に任せる。
 */
export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect(LOGIN_PATH);
}

/**
 * デモで試す: サンプルデータ入りのデモユーザーをその場で作り、そのユーザーでログインした状態にする
 * （docs/steps/pub-3.md 設計判断 2・3・4）。ログイン前の操作なので requireUserId() は呼ばない。
 *
 * **絶対条件: デモ用に作ったユーザー以外のセッションを発行しない。**
 * - **引数を受け取らない。** useActionState / フォームから呼ばれて前の状態や FormData が渡されても読まない。
 *   Cookie もクエリも読まない（IP の取得を除く）
 * - セッションを発行する相手は createDemoUser の戻り値（今作ったユーザー）だけ
 * - 既存のセッションがあっても拒否しない。新しいデモユーザーのセッションに切り替わるだけ
 * - セッションの有効期限（JWT の exp と Cookie の maxAge）は demoExpiresAt に揃える
 *
 * 成功したら DEMO_START_PATH（ダッシュボード）へ redirect する。失敗は画面に出す文言を返す。
 */
export async function startDemoAction(): Promise<DemoActionState> {
  const now = new Date();

  let created: CreateDemoUserResult;
  try {
    const ipHash = await getClientIpHash();
    if (await isDemoRateLimited(prisma, ipHash, now)) {
      return { error: DEMO_ERRORS.rateLimited };
    }
    created = await createDemoUser(prisma, { ipHash, now });
  } catch {
    // IP・DB・AUTH_SECRET のどれが原因でも内部事情は出さない（fail closed）
    return { error: DEMO_ERRORS.unavailable };
  }

  try {
    // 今作ったユーザーのセッション。期限は demoExpiresAt と同じ時刻にする
    await createSession(created.userId, {
      now,
      maxAgeSeconds: getDemoSessionMaxAgeSeconds(created.demoExpiresAt, now),
    });
  } catch {
    return { error: DEMO_ERRORS.unavailable };
  }

  // redirect は例外で抜けるので try の外で呼ぶ
  redirect(DEMO_START_PATH);
}
