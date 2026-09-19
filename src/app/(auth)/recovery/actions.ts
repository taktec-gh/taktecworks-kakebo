"use server";

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { redirect } from "next/navigation";

import { getClientIpHash } from "@/lib/client-ip";
import { listCredentials } from "@/lib/credentials";
import { isBlocked, recordLoginAttempt } from "@/lib/login-attempts";
import {
  getRpConfig,
  toAuthenticatorTransports,
  validateDeviceName,
  type PasskeyRegistrationOptionsResult,
} from "@/lib/passkey";
import { consumeChallengeCookie, setChallengeCookie } from "@/lib/passkey-session";
import { prisma } from "@/lib/prisma";
import { hashRecoveryCode, issueRecoveryCode, normalizeRecoveryCode } from "@/lib/recovery-code";
import { completeRecoveryWithPasskey, findRecoveryUserIdByCodeHash } from "@/lib/recovery-codes";
import {
  RECOVERY_CODE_FIELD_NAME,
  RECOVERY_ERRORS,
  RECOVERY_PASSKEY_PATH,
  type RecoveryCodeFormState,
  type RecoveryCodeIssuedResult,
} from "@/lib/recovery-messages";
import { clearRecoveryCookie, getRecoverySession, setRecoveryCookie } from "@/lib/recovery-session";
import { createSession } from "@/lib/session";
import { findWebauthnUserId } from "@/lib/users";
import { getPasskeyDisplayName, webauthnUserIdToBytes } from "@/lib/webauthn-user-id";

import type { RegistrationResponseJSON } from "@simplewebauthn/server";

/**
 * リカバリー（Server Action）。パスキーを全部なくしたときに、リカバリーコードで元のアカウントへ戻る
 * （docs/steps/pub-5.md 設計判断 4・5・6）。ログイン前の操作なので requireUserId() は呼ばない。
 *
 * 流れ:
 * 1. verifyRecoveryCodeAction（/recovery）: コードを照合し、リカバリー用トークンを Cookie に置いて
 *    /recovery/passkey へ移る。**ここではコードを消費しない**
 * 2. startRecoveryPasskeyRegistrationAction: リカバリー用トークンの利用者で登録用オプションを作る
 * 3. finishRecoveryPasskeyRegistrationAction: 応答を検証し、**1つのトランザクションで**資格情報の作成と
 *    コードのハッシュの差し替え（条件つき）を行う。成功したらリカバリー用トークンを消し、
 *    通常のセッションを発行し、新しいコードを一度だけ返す
 *
 * - **リカバリー用トークンは通常のセッションではない。** 2・3 はリカバリー用トークンだけを見る。
 *   通常のセッションがあってもリカバリー用トークンが無ければ失敗する
 * - 利用者はリカバリー用トークン（src/lib/auth.ts の verifyRecoveryToken が UserId にした値）からだけ決める。
 *   フォーム・応答から受け取らない
 * - 古いパスキーは消さない（設計判断 7）
 */

/**
 * リカバリーコードを照合する（useActionState から呼ぶ）。
 *
 * 1. IP 単位のレート制限（ログインと同じ LoginAttempt。15分に10回の失敗）
 * 2. 正規化 → ハッシュ → `recoveryCodeHash` が一致し `demoExpiresAt` が null の利用者を探す
 * 3. 見つかったらリカバリー用トークンを Cookie に置き、RECOVERY_PASSKEY_PATH へ redirect する
 *
 * **失敗の文言は1つ**（RECOVERY_ERRORS.invalidCode）。間違い・使用済み・レート制限・デモユーザー・
 * サーバーの事情を区別しない。照合の失敗は失敗として、成功は成功として LoginAttempt に記録する。
 * **ここではコードを消費しない**（recoveryCodeHash を変えない）。
 */
export async function verifyRecoveryCodeAction(
  _prevState: RecoveryCodeFormState,
  formData: FormData,
): Promise<RecoveryCodeFormState> {
  const failure: RecoveryCodeFormState = { error: RECOVERY_ERRORS.invalidCode };

  let ipHash: string;
  try {
    ipHash = await getClientIpHash();
    if (await isBlocked(prisma, ipHash)) {
      // 制限にかかったら照合しない。ログインと同じく失敗として記録する
      await recordLoginAttempt(prisma, ipHash, false);
      return failure;
    }
  } catch {
    // IP も DB も取れないならガードが効かないので通さない（fail closed）
    return failure;
  }

  try {
    const normalized = normalizeRecoveryCode(formData.get(RECOVERY_CODE_FIELD_NAME));
    if (normalized === null) {
      await recordFailure(ipHash);
      return failure;
    }

    const codeHash = hashRecoveryCode(normalized);
    const userId = await findRecoveryUserIdByCodeHash(prisma, codeHash);
    if (userId === null) {
      await recordFailure(ipHash);
      return failure;
    }

    await recordLoginAttempt(prisma, ipHash, true);
    await setRecoveryCookie({ userId, codeHash });
  } catch {
    await recordFailure(ipHash);
    return failure;
  }

  // redirect は例外で抜けるので try の外で呼ぶ
  redirect(RECOVERY_PASSKEY_PATH);
}

/**
 * リカバリー中の登録用オプションを作り、チャレンジ（用途 "recovery"）を短命 Cookie に置く。
 *
 * - 利用者はリカバリー用トークンから決める。無い・期限切れなら RECOVERY_ERRORS.sessionExpired
 * - user handle はその利用者の webauthnUserId、表示名も同じ（設定画面の登録と同じ）
 * - `excludeCredentials` は**その利用者の**登録済みパスキーだけ
 */
export async function startRecoveryPasskeyRegistrationAction(): Promise<PasskeyRegistrationOptionsResult> {
  try {
    const recovery = await getRecoverySession();
    if (!recovery) return { ok: false, error: RECOVERY_ERRORS.sessionExpired };

    const rpConfig = getRpConfig();

    const webauthnUserId = await findWebauthnUserId(prisma, recovery.userId);
    if (!webauthnUserId) return { ok: false, error: RECOVERY_ERRORS.sessionExpired };
    const displayName = getPasskeyDisplayName(webauthnUserId);

    const existing = await listCredentials(prisma, recovery.userId);

    const options = await generateRegistrationOptions({
      rpName: rpConfig.rpName,
      rpID: rpConfig.rpID,
      userID: webauthnUserIdToBytes(webauthnUserId),
      userName: displayName,
      userDisplayName: displayName,
      attestationType: "none",
      excludeCredentials: existing.map((credential) => ({
        id: credential.credentialId,
        transports: toAuthenticatorTransports(credential.transports),
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });

    await setChallengeCookie("recovery", options.challenge);
    return { ok: true, options };
  } catch {
    // RP_ID 未設定・DB の障害など。内部事情は出さない
    return { ok: false, error: RECOVERY_ERRORS.unavailable };
  }
}

/**
 * リカバリー中の登録応答を検証し、通れば**1つのトランザクションで**資格情報の作成とコードの差し替えを行う。
 *
 * - チャレンジ Cookie は成否にかかわらず最初に消える（単回性）
 * - リカバリー用トークンは**成功したときだけ**消す（取り消し・失敗では残し、10分の間はやり直せる）。
 *   コードがもう使えない（codeNotCurrent）ときも消す（そのトークンでは二度と完了できないため）
 * - 成功したら通常のセッションを発行し、新しいコード（表示用に区切った平文）を一度だけ返す
 */
export async function finishRecoveryPasskeyRegistrationAction(
  response: RegistrationResponseJSON,
  deviceName: string,
): Promise<RecoveryCodeIssuedResult> {
  let challenge: string | null;
  let recovery: Awaited<ReturnType<typeof getRecoverySession>>;
  try {
    challenge = await consumeChallengeCookie("recovery");
    recovery = await getRecoverySession();
  } catch {
    return { ok: false, error: RECOVERY_ERRORS.unavailable };
  }
  if (!recovery) return { ok: false, error: RECOVERY_ERRORS.sessionExpired };
  if (!challenge) return { ok: false, error: RECOVERY_ERRORS.challengeExpired };

  const validatedName = validateDeviceName(deviceName);
  if (!validatedName.ok) return { ok: false, error: validatedName.error };

  let rpConfig: ReturnType<typeof getRpConfig>;
  try {
    rpConfig = getRpConfig();
  } catch {
    return { ok: false, error: RECOVERY_ERRORS.unavailable };
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rpConfig.rpOrigin,
      expectedRPID: rpConfig.rpID,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, error: RECOVERY_ERRORS.verificationFailed };
  }
  if (!verification.verified) {
    return { ok: false, error: RECOVERY_ERRORS.verificationFailed };
  }

  const { credential } = verification.registrationInfo;
  // 平文は戻り値で画面に一度渡すだけ。DB にはハッシュだけを渡す
  const recoveryCode = issueRecoveryCode();
  let completed: Awaited<ReturnType<typeof completeRecoveryWithPasskey>>;
  try {
    completed = await completeRecoveryWithPasskey(prisma, {
      userId: recovery.userId,
      // トークンに入れた（照合した）コードのハッシュ。これがまだその利用者のコードのときだけ差し替わる
      expectedCodeHash: recovery.codeHash,
      newCodeHash: recoveryCode.hash,
      credential: {
        credentialId: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: response.response.transports ?? [],
        deviceName: validatedName.value,
      },
    });
  } catch {
    return { ok: false, error: RECOVERY_ERRORS.unavailable };
  }

  if (!completed.ok) {
    if (completed.reason === "duplicate") return { ok: false, error: RECOVERY_ERRORS.duplicate };
    // 先に同じコードでリカバリーが済んだ・設定から作り直された。このトークンでは二度と完了できない
    await clearRecoveryCookieQuietly();
    return { ok: false, error: RECOVERY_ERRORS.invalidCode };
  }

  try {
    // リカバリー用トークンを消してから、通常のセッションを発行する
    await clearRecoveryCookie();
    await createSession(recovery.userId);
  } catch {
    // パスキーは登録され、コードも差し替わっている。新しいパスキーでログインできるので一般的な失敗として返す
    return { ok: false, error: RECOVERY_ERRORS.unavailable };
  }
  return { ok: true, recoveryCode: recoveryCode.code };
}

/** 失敗の記録。記録できなくても結果（失敗）は変わらない */
async function recordFailure(ipHash: string): Promise<void> {
  try {
    await recordLoginAttempt(prisma, ipHash, false);
  } catch {
    // 記録できなくても照合の判断は済んでいる
  }
}

/** リカバリー用トークンを消す。消せなくても（10分で切れる）結果は変わらない */
async function clearRecoveryCookieQuietly(): Promise<void> {
  try {
    await clearRecoveryCookie();
  } catch {
    // 何もしない
  }
}
