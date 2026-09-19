"use server";

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

import { getClientIpHash } from "@/lib/client-ip";
import {
  getRpConfig,
  validateDeviceName,
  type PasskeyRegistrationOptionsResult,
} from "@/lib/passkey";
import { consumeSignupChallengeCookie, setSignupChallengeCookie } from "@/lib/passkey-session";
import { prisma } from "@/lib/prisma";
import { issueRecoveryCode } from "@/lib/recovery-code";
import type { RecoveryCodeIssuedResult } from "@/lib/recovery-messages";
import { createSession } from "@/lib/session";
import { isSignupRateLimited } from "@/lib/signup-limits";
import { SIGNUP_ERRORS } from "@/lib/signup-messages";
import { createUserWithPasskey } from "@/lib/users";
import {
  generateWebauthnUserId,
  getPasskeyDisplayName,
  webauthnUserIdToBytes,
} from "@/lib/webauthn-user-id";

import type { RegistrationResponseJSON } from "@simplewebauthn/server";

/**
 * サインアップ（Server Action）。ログイン前の操作なので requireUserId() は呼ばない。
 * フォームではなく Client Component（signup-form.tsx）から直接呼ぶ。
 *
 * 流れ（docs/steps/pub-2.md 設計判断 2）:
 * 1. startSignupAction: レート制限を確認し、webauthnUserId を新しく作り、
 *    チャレンジと一緒に署名付きの短命 Cookie に入れる。**DB には何も書かない**
 * 2. ブラウザでパスキーを作る
 * 3. finishSignupAction: Cookie を消費し、レート制限を再確認し、登録応答を検証する。
 *    通ったら1つのトランザクションでユーザー（リカバリーコードのハッシュを含む）・プリセット・資格情報・
 *    SignupEvent を作り、**今作ったユーザーの**セッションを発行する。
 *    成功の戻り値でリカバリーコードの平文を**一度だけ**返す（docs/steps/pub-5.md 設計判断 3）
 *
 * - **webauthnUserId は署名付き Cookie からだけ取り出す。** 登録応答やフォームから受け取らない
 * - 失敗理由は出してよい（ユーザー名が無いので登録の有無が漏れない）。
 *   ただし RP_ID 未設定などサーバーの内部事情は出さず SIGNUP_ERRORS.unavailable にする
 */

/** 登録用オプションを作り、チャレンジと webauthnUserId を短命 Cookie に置く */
export async function startSignupAction(): Promise<PasskeyRegistrationOptionsResult> {
  try {
    const ipHash = await getClientIpHash();
    if (await isSignupRateLimited(prisma, ipHash)) {
      return { ok: false, error: SIGNUP_ERRORS.rateLimited };
    }

    const rpConfig = getRpConfig();
    const webauthnUserId = generateWebauthnUserId();
    const displayName = getPasskeyDisplayName(webauthnUserId);

    const options = await generateRegistrationOptions({
      rpName: rpConfig.rpName,
      rpID: rpConfig.rpID,
      userID: webauthnUserIdToBytes(webauthnUserId),
      userName: displayName,
      userDisplayName: displayName,
      attestationType: "none",
      // 新しいユーザーなので除外する資格情報は無い。他人の資格情報IDを並べない
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });

    await setSignupChallengeCookie(options.challenge, webauthnUserId);
    return { ok: true, options };
  } catch {
    // IP・DB・RP_ID / RP_ORIGIN・AUTH_SECRET のどれが原因でも内部事情は出さない（fail closed）
    return { ok: false, error: SIGNUP_ERRORS.unavailable };
  }
}

/**
 * 登録応答を検証し、通ればユーザーを作ってそのユーザーのセッションを発行する。
 *
 * チャレンジ Cookie は**成否にかかわらず最初に消える**（単回性）。失敗したら開始からやり直す。
 * 成功しても画面遷移はここでは行わない（呼び出し元の Client Component がリカバリーコードを表示し、
 * 「控えました」の後に SIGNUP_COMPLETE_PATH へ移動する）。
 *
 * 成功時は `{ ok: true, recoveryCode }`（表示用に区切った平文）。DB にはそのハッシュだけを
 * ユーザーと同じトランザクションで保存する。**失敗時にはコードを返さない。**
 */
export async function finishSignupAction(
  response: RegistrationResponseJSON,
  deviceName: string,
): Promise<RecoveryCodeIssuedResult> {
  let signupChallenge: Awaited<ReturnType<typeof consumeSignupChallengeCookie>>;
  try {
    signupChallenge = await consumeSignupChallengeCookie();
  } catch {
    return { ok: false, error: SIGNUP_ERRORS.unavailable };
  }
  if (!signupChallenge) return { ok: false, error: SIGNUP_ERRORS.challengeExpired };

  const validatedName = validateDeviceName(deviceName);
  if (!validatedName.ok) return { ok: false, error: validatedName.error };

  // 開始から完了までの間（最大2分）に他の登録が入りうるので、完了時にも確認する
  let ipHash: string;
  try {
    ipHash = await getClientIpHash();
    if (await isSignupRateLimited(prisma, ipHash)) {
      return { ok: false, error: SIGNUP_ERRORS.rateLimited };
    }
  } catch {
    // IP も DB も取れないならガードが効かないので通さない（fail closed）
    return { ok: false, error: SIGNUP_ERRORS.unavailable };
  }

  let rpConfig: ReturnType<typeof getRpConfig>;
  try {
    rpConfig = getRpConfig();
  } catch {
    return { ok: false, error: SIGNUP_ERRORS.unavailable };
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: signupChallenge.challenge,
      expectedOrigin: rpConfig.rpOrigin,
      expectedRPID: rpConfig.rpID,
      requireUserVerification: true,
    });
  } catch {
    // 署名不正・オリジン不一致・壊れた応答。理由は分けない
    return { ok: false, error: SIGNUP_ERRORS.verificationFailed };
  }
  if (!verification.verified) {
    return { ok: false, error: SIGNUP_ERRORS.verificationFailed };
  }

  // ここより前では DB に何も書いていない（途中離脱・検証失敗でユーザーを残さない）
  const { credential } = verification.registrationInfo;
  // 平文は戻り値で画面に一度渡すだけ。DB にはハッシュだけを渡す
  const recoveryCode = issueRecoveryCode();
  let created: Awaited<ReturnType<typeof createUserWithPasskey>>;
  try {
    created = await createUserWithPasskey(prisma, {
      // 署名付き Cookie から取り出した値。応答・フォームの値は使わない
      webauthnUserId: signupChallenge.webauthnUserId,
      credential: {
        credentialId: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: response.response.transports ?? [],
        deviceName: validatedName.value,
      },
      ipHash,
      recoveryCodeHash: recoveryCode.hash,
    });
  } catch {
    return { ok: false, error: SIGNUP_ERRORS.unavailable };
  }
  if (!created.ok) return { ok: false, error: SIGNUP_ERRORS.duplicate };

  try {
    // 今作ったユーザーのセッション
    await createSession(created.userId);
  } catch {
    // ユーザーは作られている。ログイン画面から入れるので、一般的な失敗として返す
    // （コードは返さない。ログイン後に設定から作り直せる）
    return { ok: false, error: SIGNUP_ERRORS.unavailable };
  }
  return { ok: true, recoveryCode: recoveryCode.code };
}
