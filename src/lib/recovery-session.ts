import { cookies } from "next/headers";

import {
  createRecoveryToken,
  getAuthSecret,
  getRecoveryCookieOptions,
  RECOVERY_COOKIE_NAME,
  verifyRecoveryToken,
  type CreateRecoveryTokenInput,
  type RecoveryTokenPayload,
} from "@/lib/auth";

/**
 * リカバリー用トークンの Cookie を伴う副作用側（docs/steps/pub-5.md 設計判断 5）。
 * 純粋ロジック（発行・検証）は src/lib/auth.ts。src/lib/session.ts と同じ分け方。
 *
 * **ここで扱うのは通常のセッションではない。** セッションの Cookie（SESSION_COOKIE_NAME）には触れず、
 * requireUserId() もこの Cookie を読まない。リカバリー用トークンでできるのはパスキーの登録だけ。
 *
 * Server Component / Server Action からのみ呼べる。
 */

/** リカバリー用トークンを発行して Cookie に置く（有効期間10分） */
export async function setRecoveryCookie(input: CreateRecoveryTokenInput): Promise<void> {
  const token = await createRecoveryToken(getAuthSecret(), input);
  const cookieStore = await cookies();
  cookieStore.set(RECOVERY_COOKIE_NAME, token, getRecoveryCookieOptions());
}

/**
 * 現在のリカバリー用トークンを検証して返す。無い・期限切れ・改竄・typ 違い（セッション JWT など）なら null。
 * **消費しない**（登録を取り消してもやり直せるように、登録が済むまで残す）。
 */
export async function getRecoverySession(): Promise<RecoveryTokenPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(RECOVERY_COOKIE_NAME)?.value;
  return verifyRecoveryToken(token, getAuthSecret());
}

/** リカバリー用トークンの Cookie を消す（リカバリーの完了時・コードが使えなくなったとき） */
export async function clearRecoveryCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(RECOVERY_COOKIE_NAME);
}
