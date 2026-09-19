"use server";

import { redirect } from "next/navigation";

import { LOGIN_PATH } from "@/lib/auth";
import { destroySession } from "@/lib/session";

/**
 * ログアウト。
 *
 * 公開版ではパスワードログインと緊急脱出モードを廃止した
 * （docs/steps/pub-1.md 設計判断 1）。ログインはパスキーのみで、passkey-actions.ts が担当する。
 */

/** ログアウト。Cookie を破棄してログインページへ戻す */
export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect(LOGIN_PATH);
}
