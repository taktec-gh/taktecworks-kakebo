"use server";

import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

import { LOGIN_ERROR_MESSAGE } from "@/lib/auth";
import { getClientIpHash } from "@/lib/client-ip";
import { findCredentialByCredentialId, updateCredentialCounter } from "@/lib/credentials";
import { isBlocked, recordLoginAttempt } from "@/lib/login-attempts";
import {
  getRpConfig,
  isCounterRegression,
  toAuthenticatorTransports,
  type PasskeyAuthenticationOptionsResult,
  type PasskeyVerificationResult,
} from "@/lib/passkey";
import { consumeChallengeCookie, setChallengeCookie } from "@/lib/passkey-session";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/session";
import { brandUserIdFromTrustedSource } from "@/lib/user-id";

import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

/**
 * パスキーでのログイン（Server Action）。フォームではなく Client Component から直接呼ぶ。
 *
 * 公開版のログイン手段はこれだけ（パスワードログインは廃止。docs/steps/pub-1.md 設計判断 1）。
 *
 * **失敗の理由は一切返さない。** 期限切れ・未登録・署名不正・レート制限のいずれでも
 * LOGIN_ERROR_MESSAGE を返す。
 * 理由を返すと「そのパスキーが登録されているか」が外から分かってしまう。
 *
 * レート制限は IP 単位（src/lib/login-attempts.ts）。
 *
 * **セッションを発行する相手は、検証に通った資格情報の持ち主（Credential.userId）。**
 * 利用者IDをリクエスト（フォーム・URL・Cookie）から受け取らない。
 */

/** 認証用オプションを作り、チャレンジを短命 Cookie に置く */
export async function startPasskeyLoginAction(): Promise<PasskeyAuthenticationOptionsResult> {
  try {
    const ipHash = await getClientIpHash();
    if (await isBlocked(prisma, ipHash)) {
      return { ok: false, error: LOGIN_ERROR_MESSAGE };
    }

    const { rpID } = getRpConfig();

    // allowCredentials は渡さない。ログイン画面は未認証の相手にも見えるため、
    // 登録済み資格情報の ID を晒さない。パスキーは discoverable credential
    // （登録時 residentKey: "required"）なのでブラウザ側で候補を出せる。
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
    });

    await setChallengeCookie("authenticate", options.challenge);
    return { ok: true, options };
  } catch {
    // RP_ID / RP_ORIGIN の未設定も含め、理由は画面へ出さない
    return { ok: false, error: LOGIN_ERROR_MESSAGE };
  }
}

/**
 * 認証応答を検証し、通ればその資格情報の持ち主のセッションを発行する。
 *
 * 成功しても画面遷移はここでは行わない（呼び出し元の Client Component が
 * ルータで "/" へ移動する）。
 */
export async function verifyPasskeyLoginAction(
  response: AuthenticationResponseJSON,
): Promise<PasskeyVerificationResult> {
  let ipHash: string;
  try {
    ipHash = await getClientIpHash();
    if (await isBlocked(prisma, ipHash)) {
      await recordLoginAttempt(prisma, ipHash, false);
      return { ok: false, error: LOGIN_ERROR_MESSAGE };
    }
  } catch {
    // IP も DB も取れないならガードが効かないので通さない（fail closed）
    return { ok: false, error: LOGIN_ERROR_MESSAGE };
  }

  try {
    // チャレンジは成否にかかわらずここで消える（単回性）
    const challenge = await consumeChallengeCookie("authenticate");
    if (!challenge) {
      await recordFailure(ipHash);
      return { ok: false, error: LOGIN_ERROR_MESSAGE };
    }

    const { rpID, rpOrigin } = getRpConfig();

    const credential = await findCredentialByCredentialId(prisma, response.id);
    if (!credential) {
      await recordFailure(ipHash);
      return { ok: false, error: LOGIN_ERROR_MESSAGE };
    }

    const storedCounter = Number(credential.counter);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rpOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: credential.credentialId,
        publicKey: credential.publicKey,
        counter: storedCounter,
        transports: toAuthenticatorTransports(credential.transports),
      },
    });

    if (!verification.verified) {
      await recordFailure(ipHash);
      return { ok: false, error: LOGIN_ERROR_MESSAGE };
    }

    const newCounter = verification.authenticationInfo.newCounter;
    if (isCounterRegression(storedCounter, newCounter)) {
      // 署名カウンタが巻き戻っている＝資格情報が複製された疑い
      await recordFailure(ipHash);
      return { ok: false, error: LOGIN_ERROR_MESSAGE };
    }

    await updateCredentialCounter(prisma, credential.credentialId, newCounter, new Date());
    await recordLoginAttempt(prisma, ipHash, true);
    // 署名・チャレンジ・カウンタの検証に通った資格情報の持ち主（設計判断 7 の許可リスト）
    await createSession(brandUserIdFromTrustedSource(credential.userId));
    return { ok: true };
  } catch {
    await recordFailure(ipHash);
    return { ok: false, error: LOGIN_ERROR_MESSAGE };
  }
}

/** 失敗の記録。記録できなくても結果（失敗）は変わらない */
async function recordFailure(ipHash: string): Promise<void> {
  try {
    await recordLoginAttempt(prisma, ipHash, false);
  } catch {
    // 記録できなくても認証の判断は済んでいる
  }
}
