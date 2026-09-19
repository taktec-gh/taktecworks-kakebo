import { cookies } from "next/headers";

import { getAuthSecret } from "@/lib/auth";
import {
  createChallengeToken,
  createSignupChallengeToken,
  getChallengeCookieName,
  getChallengeCookieOptions,
  SIGNUP_CHALLENGE_COOKIE_NAME,
  verifyChallengeToken,
  verifySignupChallengeToken,
  type ChallengePurpose,
  type SignupChallenge,
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

/**
 * サインアップ用: チャレンジと webauthnUserId を署名して Cookie に載せる
 * （docs/steps/pub-2.md 設計判断 2）。DB には何も書かない。
 */
export async function setSignupChallengeCookie(
  challenge: string,
  webauthnUserId: string,
): Promise<void> {
  const token = await createSignupChallengeToken(challenge, webauthnUserId, getAuthSecret());
  const cookieStore = await cookies();
  cookieStore.set(SIGNUP_CHALLENGE_COOKIE_NAME, token, getChallengeCookieOptions());
}

/**
 * サインアップ用: チャレンジと webauthnUserId を取り出し、**成否にかかわらず Cookie を削除する**（単回性）。
 *
 * 期限切れ・改竄・用途違い（設定画面の登録用・ログイン用のトークン）・webauthnUserId の欠落は null。
 */
export async function consumeSignupChallengeCookie(): Promise<SignupChallenge | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SIGNUP_CHALLENGE_COOKIE_NAME)?.value;

  // 検証の前に消す。検証で例外が出ても再利用できないようにするため
  cookieStore.delete(SIGNUP_CHALLENGE_COOKIE_NAME);

  return verifySignupChallengeToken(token, getAuthSecret());
}
