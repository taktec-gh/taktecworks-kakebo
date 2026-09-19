import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { createCredential, type CreateCredentialInput } from "@/lib/credentials";
import { isRecoveryCodeHash } from "@/lib/recovery-code";
import type { UserId } from "@/lib/user-id";

/**
 * リカバリーコードのデータ層（User.recoveryCodeHash。docs/steps/pub-5.md）。
 *
 * - DB に渡すのは**ハッシュだけ**（src/lib/recovery-code.ts の hashRecoveryCode の値）。
 *   ハッシュの形（64文字の16進）でない値は書き込まない（平文を渡す取り違えを防ぐ）
 * - 利用者自身の行を更新するときは `where: { id: userId, ... }` で絞る
 * - **コードの消費（差し替え）は、新しいパスキーの登録と同じトランザクションで行う**（設計判断 4）
 *
 * 例外: findRecoveryUserIdByCodeHash は userId を取らない（コードを入力した時点では利用者が分からない。
 * コードのハッシュで引くことが照合そのもの）。戻り値は UserId ではなくただの文字列で、
 * UserId にするのはリカバリー用トークンの検証（src/lib/auth.ts）だけ。
 */

/** ハッシュの形でない値を書き込もうとしたら例外にする（平文・空文字を保存しない） */
function assertRecoveryCodeHash(value: string): void {
  if (!isRecoveryCodeHash(value)) throw new Error("invalid recovery code hash");
}

/**
 * コードのハッシュから、リカバリーしてよい利用者の ID を探す。無ければ null。
 *
 * - 条件は `recoveryCodeHash` の一致と **`demoExpiresAt: null`**（デモユーザーは対象にしない）
 * - **コードを消費しない**（ここでは照合だけ。消費は completeRecoveryWithPasskey）
 * - 戻り値はリカバリー用トークンの sub にする。ここでは UserId にしない
 */
export async function findRecoveryUserIdByCodeHash(
  client: PrismaClient,
  codeHash: string,
): Promise<string | null> {
  if (!isRecoveryCodeHash(codeHash)) return null;
  const user = await client.user.findFirst({
    where: { recoveryCodeHash: codeHash, demoExpiresAt: null },
    select: { id: true },
  });
  return user?.id ?? null;
}

/**
 * コードのハッシュを差し替える（**条件つき更新**）。1件更新できたら true。
 *
 * 条件は `where: { id: userId, recoveryCodeHash: expectedHash }`。リカバリー用トークンに入れたハッシュが
 * まだその利用者のコードであるときだけ更新する。先に同じコードでリカバリーが済んでいた・設定から
 * 作り直されていた場合は0件になる。
 *
 * client は completeRecoveryWithPasskey のトランザクションの tx。単独では呼ばない（export しない）。
 */
async function replaceRecoveryCodeHash(
  tx: Prisma.TransactionClient,
  userId: UserId,
  expectedHash: string,
  newHash: string,
): Promise<boolean> {
  const result = await tx.user.updateMany({
    where: { id: userId, recoveryCodeHash: expectedHash },
    data: { recoveryCodeHash: newHash },
  });
  return result.count === 1;
}

export type CompleteRecoveryInput = {
  /** リカバリー用トークンの sub（検証済み） */
  userId: UserId;
  /** リカバリー用トークンに入れた、照合したコードのハッシュ */
  expectedCodeHash: string;
  /** 新しく発行したコードのハッシュ */
  newCodeHash: string;
  /** 検証済みの登録応答から取り出した資格情報 */
  credential: CreateCredentialInput;
};

export type CompleteRecoveryResult =
  | { ok: true }
  /** 同じ資格情報IDが登録済み（誰のものでも）。何も変わっていない */
  | { ok: false; reason: "duplicate" }
  /** コードがもう使えない（先に使われた・作り直された・利用者が消えた）。何も変わっていない */
  | { ok: false; reason: "codeNotCurrent" };

/** トランザクションを戻すための内部の例外 */
class RecoveryAbortError extends Error {
  constructor(readonly reason: "duplicate" | "codeNotCurrent") {
    super(`recovery aborted: ${reason}`);
    this.name = "RecoveryAbortError";
  }
}

/**
 * リカバリーの完了: **1つのトランザクションで**
 * 1. コードのハッシュを新しいハッシュに差し替える（条件 `where: { id: userId, recoveryCodeHash: expectedCodeHash }`）
 * 2. 資格情報（新しいパスキー）を作る
 *
 * 差し替えが1件でなければ（同じコードで先にリカバリーが済んだ・作り直された）、**資格情報も作らずに全部を戻す。**
 * 資格情報が重複したら、差し替えも戻す。
 * 同じコードで2つのリカバリーが並んでも、先に終わった方だけが通る（後の方の UPDATE は User の行ロックを待ち、
 * PostgreSQL がロックの後で条件を評価し直すので0件になる）。
 *
 * **差し替えを先に行う理由。** 資格情報の INSERT は外部キーの確認で User の行に共有ロック（FOR KEY SHARE）を取る。
 * recoveryCodeHash は一意索引のある列なので、その UPDATE は排他ロック（FOR UPDATE）を要し、共有ロックと衝突する。
 * 「INSERT → UPDATE」の順だと、並んだ2つのトランザクションが互いの共有ロックを待ってデッドロックになる
 * （実DBの検証スクリプト prisma/checks/recovery-code.ts で確認した）。先に UPDATE で行を押さえれば、後の方は待つだけになる。
 *
 * 登録応答の検証は呼び出し側で**この関数を呼ぶ前に**済ませること。古いパスキーは消さない（設計判断 7）。
 * 失敗は戻り値で返す。それ以外の失敗は例外のまま投げる。
 */
export async function completeRecoveryWithPasskey(
  client: PrismaClient,
  input: CompleteRecoveryInput,
): Promise<CompleteRecoveryResult> {
  assertRecoveryCodeHash(input.expectedCodeHash);
  assertRecoveryCodeHash(input.newCodeHash);

  try {
    await client.$transaction(async (tx) => {
      const replaced = await replaceRecoveryCodeHash(
        tx,
        input.userId,
        input.expectedCodeHash,
        input.newCodeHash,
      );
      // 失敗を戻り値で返すとトランザクションがコミットされてしまうので、例外で抜けて全部を戻す
      if (!replaced) throw new RecoveryAbortError("codeNotCurrent");

      const credential = await createCredential(tx, input.userId, input.credential);
      if (!credential.ok) throw new RecoveryAbortError("duplicate");
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof RecoveryAbortError) return { ok: false, reason: error.reason };
    throw error;
  }
}

/**
 * 設定画面からの作り直し: その利用者のコードのハッシュを新しいハッシュにする。1件更新できたら true。
 *
 * `where: { id: userId }` で絞る（userId は requireUserId() の値）。**古いコードはこの時点で使えなくなる。**
 * デモユーザーの拒否は呼び出し側（regenerateRecoveryCodeAction）が DB の demoExpiresAt を見て行う。
 */
export async function regenerateRecoveryCodeHash(
  client: PrismaClient,
  userId: UserId,
  newHash: string,
): Promise<boolean> {
  assertRecoveryCodeHash(newHash);
  const result = await client.user.updateMany({
    where: { id: userId },
    data: { recoveryCodeHash: newHash },
  });
  return result.count === 1;
}

/** その利用者がリカバリーコードを持っているか（発行済みか）。`where: { id: userId }` で絞る。ハッシュそのものは返さない */
export async function hasRecoveryCode(client: PrismaClient, userId: UserId): Promise<boolean> {
  const user = await client.user.findFirst({
    where: { id: userId },
    select: { recoveryCodeHash: true },
  });
  return typeof user?.recoveryCodeHash === "string";
}
