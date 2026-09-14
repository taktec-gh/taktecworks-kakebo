import { cookies } from "next/headers";

import { getAuthSecret } from "@/lib/auth";
import {
  createChallengeToken,
  getChallengeCookieName,
  getChallengeCookieOptions,
  verifyChallengeToken,
  type ChallengePurpose,
} from "@/lib/passkey";

/**
 * チャレンジ Cookie を伴う副作用側。純粋ロジックは src/lib/passkey.ts。
 * Server Action / Route Handler からのみ呼べる（src/lib/session.ts と同じ分け方）。
 */

/** チャレンジを署名して Cookie に載せる */
export async function setChallengeCookie(
  purpose: ChallengePurpose,
  challenge: string,
): Promise<void> {
  const token = await createChallengeToken(challenge, purpose, getAuthSecret());
  const cookieStore = await cookies();
  cookieStore.set(getChallengeCookieName(purpose), token, getChallengeCookieOptions());
}

/**
 * チャレンジを取り出し、**成否にかかわらず Cookie を削除する**（単回性）。
 *
 * 期限切れ・改竄・用途違い（登録用チャレンジで認証しようとした等）は null。
 */
export async function consumeChallengeCookie(
  purpose: ChallengePurpose,
): Promise<string | null> {
  const cookieName = getChallengeCookieName(purpose);
  const cookieStore = await cookies();
  const token = cookieStore.get(cookieName)?.value;

  // 検証の前に消す。検証で例外が出ても再利用できないようにするため
  cookieStore.delete(cookieName);

  return verifyChallengeToken(token, purpose, getAuthSecret());
}

/** チャレンジ Cookie を捨てる（中断時の後始末） */
export async function clearChallengeCookie(purpose: ChallengePurpose): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(getChallengeCookieName(purpose));
}
