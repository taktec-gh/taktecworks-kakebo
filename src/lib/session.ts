import { cookies } from "next/headers";

import {
  createSessionToken,
  getAuthSecret,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
  verifySessionToken,
  type SessionPayload,
} from "@/lib/auth";

/**
 * Cookie を伴う副作用側。純粋ロジックは src/lib/auth.ts。
 * Server Component / Server Action / Route Handler からのみ呼べる。
 */

/** セッション Cookie を発行する */
export async function createSession(): Promise<void> {
  const token = await createSessionToken(getAuthSecret());
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, getSessionCookieOptions());
}

/** 現在のセッションを取得する。未ログイン・改竄・期限切れなら null */
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token, getAuthSecret());
}

/** セッション Cookie を破棄する */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}
