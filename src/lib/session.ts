import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  createSessionToken,
  getAuthSecret,
  getSessionCookieOptions,
  LOGIN_PATH,
  SESSION_COOKIE_NAME,
  verifySessionToken,
  type SessionPayload,
} from "@/lib/auth";
import type { UserId } from "@/lib/user-id";

/**
 * Cookie を伴う副作用側。純粋ロジックは src/lib/auth.ts。
 * Server Component / Server Action / Route Handler からのみ呼べる。
 */

export type CreateSessionOptions = {
  /**
   * 有効期間（秒）。JWT の exp（= iat + maxAgeSeconds）と Cookie の maxAge の両方に使う。
   * 既定は SESSION_MAX_AGE_SECONDS（30日。通常のユーザー）。
   * デモユーザーは demoExpiresAt までの秒数を渡す（docs/steps/pub-3.md 設計判断 2）
   */
  maxAgeSeconds?: number;
  /** 発行時刻（JWT の iat）。既定は現在時刻 */
  now?: Date;
};

/** そのユーザーのセッション Cookie を発行する */
export async function createSession(
  userId: UserId,
  options: CreateSessionOptions = {},
): Promise<void> {
  const token = await createSessionToken(getAuthSecret(), userId, {
    now: options.now,
    maxAgeSeconds: options.maxAgeSeconds,
  });
  const cookieStore = await cookies();
  cookieStore.set(
    SESSION_COOKIE_NAME,
    token,
    getSessionCookieOptions({ maxAgeSeconds: options.maxAgeSeconds }),
  );
}

/** 現在のセッションを取得する。未ログイン・改竄・期限切れなら null */
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return verifySessionToken(token, getAuthSecret());
}

/**
 * ログイン中の利用者IDを返す。セッションが無ければログイン画面へリダイレクトする。
 *
 * **全 Server Action と、データを出す全ページの先頭で呼ぶ。** データ層へ渡す userId は
 * 必ずこの戻り値にする。proxy のガードはセッションの有無しか見ず、ユーザーIDを渡せないため、
 * proxy とは別にここでも確認する（Server Action は POST で直接叩けるため）。
 *
 * セッションのユーザーが DB に存在するかは照合しない（docs/steps/pub-1.md 設計判断 8）。
 * 消えたユーザーのセッションでは一覧が空になり、作成は外部キー違反で失敗する。
 */
export async function requireUserId(): Promise<UserId> {
  const session = await getSession();
  if (!session) redirect(LOGIN_PATH);
  return session.userId;
}

/** セッション Cookie を破棄する */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}
