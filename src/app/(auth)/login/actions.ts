"use server";

import { redirect } from "next/navigation";

import { getAppPassword, LOGIN_ERROR_MESSAGE, LOGIN_PATH, verifyPassword } from "@/lib/auth";
import { getClientIpHash } from "@/lib/client-ip";
import { countCredentials } from "@/lib/credentials";
import { isBlocked, recordLoginAttempt } from "@/lib/login-attempts";
import { isRecoveryMode, shouldRequirePasskey } from "@/lib/passkey";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession } from "@/lib/session";

import type { LoginState } from "./login-state";

/**
 * パスワードでのログイン。useActionState から呼ぶ前提のシグネチャ。
 *
 * 成功時: セッション Cookie を発行して "/" へリダイレクト（redirect が例外を投げるため戻り値なし）
 * 失敗時: { error: LOGIN_ERROR_MESSAGE }
 *
 * **どの理由で失敗しても同じメッセージを返す。**
 * レート制限中・パスキーが必須・パスワードが誤り・APP_PASSWORD 未設定 を
 * 区別させると、攻撃者に状態が漏れる（docs/steps/step-7.md）。
 *
 * 処理順は docs/steps/step-7.md「ログインの処理順」のとおり:
 * 1. IP を HMAC する
 * 2. ブロック中ならパスワードを見ずに失敗（この試行も失敗として記録する）
 * 3. 資格情報が1件以上あればパスワードを見ずに失敗（同上）
 * 4. APP_PASSWORD 未設定なら失敗
 * 5. パスワード照合
 * 6. 成功を記録してセッション発行
 *
 * ガードの途中で DB やヘッダの取得に失敗した場合は**通さない**（fail closed）。
 * 通してしまうと、DB を落とすだけでパスキー必須化を迂回できることになる。
 */
export async function loginAction(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const raw = formData.get("password");
  const password = typeof raw === "string" ? raw : "";

  let ipHash: string;
  let rejectedByGuard: boolean;
  try {
    ipHash = await getClientIpHash();

    if (await isBlocked(prisma, ipHash)) {
      // ブロック中の試行も攻撃の一部なので記録する
      rejectedByGuard = true;
    } else {
      const credentialCount = await countCredentials(prisma);
      rejectedByGuard = shouldRequirePasskey(credentialCount, isRecoveryMode());
    }
  } catch {
    return { error: LOGIN_ERROR_MESSAGE };
  }

  if (rejectedByGuard) {
    await recordAttempt(ipHash, false);
    return { error: LOGIN_ERROR_MESSAGE };
  }

  let expected: string;
  try {
    expected = getAppPassword();
  } catch {
    // APP_PASSWORD 未設定。設定漏れを画面に晒さないよう通常の失敗と同じ扱いにする。
    await recordAttempt(ipHash, false);
    return { error: LOGIN_ERROR_MESSAGE };
  }

  if (!verifyPassword(password, expected)) {
    await recordAttempt(ipHash, false);
    return { error: LOGIN_ERROR_MESSAGE };
  }

  await recordAttempt(ipHash, true);
  await createSession();
  redirect("/");
}

/**
 * 試行の記録。記録に失敗してもログインの結果は変えない。
 *
 * ここまで来ている時点で DB への疎通は取れているため、
 * 記録だけが落ちるのは稀。稀な失敗で利用者を締め出さないことを優先する。
 */
async function recordAttempt(ipHash: string, succeeded: boolean): Promise<void> {
  try {
    await recordLoginAttempt(prisma, ipHash, succeeded);
  } catch {
    // 記録できなくても認証の判断は済んでいる
  }
}

/** ログアウト。Cookie を破棄してログインページへ戻す */
export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect(LOGIN_PATH);
}
