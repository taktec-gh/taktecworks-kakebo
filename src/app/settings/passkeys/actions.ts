"use server";

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { revalidatePath } from "next/cache";

import { createCredential, deleteCredential, listCredentials } from "@/lib/credentials";
import { DEMO_PASSKEY_BLOCKED_MESSAGE } from "@/lib/demo-messages";
import {
  getRpConfig,
  PASSKEY_ERRORS,
  toAuthenticatorTransports,
  validateCredentialId,
  validateDeviceName,
  type PasskeyRegistrationOptionsResult,
  type PasskeyVerificationResult,
} from "@/lib/passkey";
import { consumeChallengeCookie, setChallengeCookie } from "@/lib/passkey-session";
import { prisma } from "@/lib/prisma";
import { issueRecoveryCode } from "@/lib/recovery-code";
import { regenerateRecoveryCodeHash } from "@/lib/recovery-codes";
import {
  DEMO_RECOVERY_CODE_BLOCKED_MESSAGE,
  RECOVERY_REGENERATE_ERRORS,
  type RecoveryCodeIssuedResult,
} from "@/lib/recovery-messages";
import { requireUserId } from "@/lib/session";
import type { UserId } from "@/lib/user-id";
import { findDemoExpiresAt, findWebauthnUserId } from "@/lib/users";
import { getPasskeyDisplayName, webauthnUserIdToBytes } from "@/lib/webauthn-user-id";

import { PASSKEYS_PATH, type PasskeyActionState } from "./action-state";

import type { RegistrationResponseJSON } from "@simplewebauthn/server";

/**
 * パスキーの登録・削除（Server Action）。**すべて要ログイン。**
 *
 * Server Action は POST エンドポイントとして直接叩けるため、
 * 画面側のガード（proxy）とは別に各アクションの先頭で requireUserId() を呼び、
 * データ層へは必ずその戻り値（ログイン中の利用者ID）を渡す（docs/steps/pub-1.md）。
 *
 * ログイン画面と違い、**ここでは失敗の理由を出してよい**
 * （すでにログインしている本人しか到達しないため。docs/steps/step-7.md「画面」）。
 *
 * **デモユーザーは登録できない**（docs/steps/pub-3.md 設計判断 7）。開始・完了の両方で、
 * DB の demoExpiresAt を userId で絞って取得して判定する（Server Action は直接叩けるため、画面の表示に頼らない）。
 */

/** その利用者がデモユーザーか（DB の demoExpiresAt で判定。`where: { id: userId }`） */
async function isDemoUser(userId: UserId): Promise<boolean> {
  return (await findDemoExpiresAt(prisma, userId)) !== null;
}

/**
 * 登録用オプションを作り、チャレンジを短命 Cookie に置く。
 *
 * - `excludeCredentials` に**その利用者の**登録済みを並べ、同じ認証器の二重登録を防ぐ。
 *   全件を並べると他人の資格情報IDがブラウザに渡るので、必ず userId で絞った一覧を使う
 * - `residentKey: "required"` にして discoverable credential を作る。
 *   これによりログイン画面で allowCredentials を晒さずに認証できる
 * - `userVerification: "required"`。パスキー1本でログインできる以上、
 *   生体認証か PIN を必ず挟む
 */
export async function startPasskeyRegistrationAction(): Promise<PasskeyRegistrationOptionsResult> {
  const userId = await requireUserId();

  // デモユーザーはパスキーを登録できない（pub-3.md 設計判断 7）。画面の表示に頼らず DB の値で判定する
  if (await isDemoUser(userId)) return { ok: false, error: DEMO_PASSKEY_BLOCKED_MESSAGE };

  let rpConfig: ReturnType<typeof getRpConfig>;
  try {
    rpConfig = getRpConfig();
  } catch {
    return { ok: false, error: PASSKEY_ERRORS.configMissing };
  }

  // user handle はそのユーザーの webauthnUserId（毎回新しく作らない）。
  // 同じ利用者の2本目以降のパスキーが、認証器から同じアカウントに見えるようにする（pub-2.md 設計判断 3・7）
  const webauthnUserId = await findWebauthnUserId(prisma, userId);
  if (!webauthnUserId) return { ok: false, error: PASSKEY_ERRORS.accountNotFound };
  const displayName = getPasskeyDisplayName(webauthnUserId);

  const existing = await listCredentials(prisma, userId);

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

  await setChallengeCookie("register", options.challenge);
  return { ok: true, options };
}

/**
 * 登録応答を検証して保存する。
 *
 * チャレンジは成否にかかわらず消える（単回性）。失敗したら
 * 画面から登録し直してもらう。
 */
export async function finishPasskeyRegistrationAction(
  response: RegistrationResponseJSON,
  deviceName: string,
): Promise<PasskeyVerificationResult> {
  const userId = await requireUserId();

  // 開始を経ずに直接叩かれても、デモユーザーには資格情報を作らない（pub-3.md 設計判断 7）
  if (await isDemoUser(userId)) return { ok: false, error: DEMO_PASSKEY_BLOCKED_MESSAGE };

  const validatedName = validateDeviceName(deviceName);
  if (!validatedName.ok) return { ok: false, error: validatedName.error };

  const challenge = await consumeChallengeCookie("register");
  if (!challenge) return { ok: false, error: PASSKEY_ERRORS.challengeExpired };

  let rpConfig: ReturnType<typeof getRpConfig>;
  try {
    rpConfig = getRpConfig();
  } catch {
    return { ok: false, error: PASSKEY_ERRORS.configMissing };
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
    // 署名不正・オリジン不一致・壊れた応答。理由は分けない
    return { ok: false, error: PASSKEY_ERRORS.verificationFailed };
  }

  if (!verification.verified) {
    return { ok: false, error: PASSKEY_ERRORS.verificationFailed };
  }

  const { credential } = verification.registrationInfo;
  const created = await createCredential(prisma, userId, {
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: response.response.transports ?? [],
    deviceName: validatedName.value,
  });
  if (!created.ok) return { ok: false, error: created.error };

  revalidatePath(PASSKEYS_PATH);
  return { ok: true };
}

/**
 * 削除。useActionState から呼ぶ前提のシグネチャ。
 *
 * その利用者の最後の1本は消せない（判定は credentials.ts）。
 */
export async function deletePasskeyAction(
  _prevState: PasskeyActionState,
  formData: FormData,
): Promise<PasskeyActionState> {
  const userId = await requireUserId();

  const id = validateCredentialId(formData.get("id"));
  if (!id.ok) return { error: id.error };

  const result = await deleteCredential(prisma, userId, id.value);
  if (!result.ok) return { error: result.error };

  revalidatePath(PASSKEYS_PATH);
  return { error: null };
}

/**
 * リカバリーコードを作り直す（docs/steps/pub-5.md 設計判断 8）。新しいコード（表示用に区切った平文）を一度だけ返す。
 *
 * - `requireUserId()` の値で `where: { id: userId }` を更新する。**古いコードはこの時点で使えなくなる**
 * - **デモユーザーは拒否する**（DB の demoExpiresAt を userId で絞って見る。画面の表示に頼らない）
 * - 作り直しの前のパスキーでの再認証は求めない（セッションの個別失効と一緒に考える。範囲外）
 * - DB に渡すのはハッシュだけ
 */
export async function regenerateRecoveryCodeAction(): Promise<RecoveryCodeIssuedResult> {
  const userId = await requireUserId();

  try {
    if (await isDemoUser(userId)) return { ok: false, error: DEMO_RECOVERY_CODE_BLOCKED_MESSAGE };

    const recoveryCode = issueRecoveryCode();
    const updated = await regenerateRecoveryCodeHash(prisma, userId, recoveryCode.hash);
    if (!updated) return { ok: false, error: RECOVERY_REGENERATE_ERRORS.accountNotFound };

    revalidatePath(PASSKEYS_PATH);
    return { ok: true, recoveryCode: recoveryCode.code };
  } catch {
    return { ok: false, error: RECOVERY_REGENERATE_ERRORS.unavailable };
  }
}
