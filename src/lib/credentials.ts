import type { Credential, PrismaClient } from "@/generated/prisma/client";

import {
  getCredentialDeleteBlockedReason,
  PASSKEY_ERRORS,
  type PasskeyResult,
} from "@/lib/passkey";
import type { UserId } from "@/lib/user-id";

/**
 * パスキー（Credential）のデータ層。
 *
 * PrismaClient は引数で受け取る（src/lib/categories.ts と同じ方針。
 * テストからモックを差し込めるようにするため）。このモジュールはサーバー専用で、
 * Client Component から import しないこと（publicKey / counter を
 * ブラウザへ渡さないためでもある）。
 *
 * **userId で絞る（docs/steps/pub-1.md 設計判断 6）。** 例外は次の2つだけ:
 * - findCredentialByCredentialId — ログインの時点では持ち主が分からない。
 *   認証器が返した資格情報IDで引くことが認証そのもの
 * - updateCredentialCounter — 上の検証が通った直後に、同じ資格情報IDで更新する
 */

/** Prisma のエラーコードを取り出す（src/lib/categories.ts と同じ） */
function getPrismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** その利用者のパスキーを登録順（古い順）で。画面の一覧と excludeCredentials に使う */
export async function listCredentials(
  client: PrismaClient,
  userId: UserId,
): Promise<Credential[]> {
  return client.credential.findMany({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * 認証器が返した資格情報ID（base64url）で1件引く。無ければ null。
 *
 * **userId を取らない例外。** ログインの時点では持ち主が分からないため。
 * 戻り値の userId が、認証成功後にセッションを発行する相手になる。
 */
export async function findCredentialByCredentialId(
  client: PrismaClient,
  credentialId: string,
): Promise<Credential | null> {
  return client.credential.findUnique({ where: { credentialId } });
}

export type CreateCredentialInput = {
  /** base64url 文字列 */
  credentialId: string;
  /**
   * COSE 形式の公開鍵。
   * Prisma の Bytes は `Uint8Array<ArrayBuffer>`（SharedArrayBuffer 由来は不可）。
   * @simplewebauthn/server の `Uint8Array_` もこの型なのでそのまま渡せる。
   */
  publicKey: Uint8Array<ArrayBuffer>;
  /** 認証器が申告した署名カウンタ */
  counter: number;
  transports: string[];
  /** 「iPhone」など利用者が付ける名前 */
  deviceName: string;
};

/** その利用者のパスキーとして追加する。同じ資格情報IDが登録済みなら（誰のものでも）拒否する */
export async function createCredential(
  client: PrismaClient,
  userId: UserId,
  input: CreateCredentialInput,
): Promise<PasskeyResult<Credential>> {
  try {
    const created = await client.credential.create({
      data: {
        userId,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        counter: BigInt(input.counter),
        transports: input.transports,
        deviceName: input.deviceName,
      },
    });
    return { ok: true, value: created };
  } catch (error) {
    if (getPrismaErrorCode(error) === "P2002") {
      return { ok: false, error: PASSKEY_ERRORS.duplicate };
    }
    throw error;
  }
}

/**
 * 認証成功のたびに署名カウンタと最終利用日時を更新する。
 * counter はクローン検知に使うため、認証のたびに必ず保存する。
 *
 * **userId を取らない例外。** findCredentialByCredentialId で引いて検証が通った直後に、
 * 同じ資格情報IDで更新する。
 */
export async function updateCredentialCounter(
  client: PrismaClient,
  credentialId: string,
  counter: number,
  usedAt: Date,
): Promise<void> {
  await client.credential.update({
    where: { credentialId },
    data: { counter: BigInt(counter), lastUsedAt: usedAt },
  });
}

/**
 * その利用者のパスキーを削除する。
 *
 * **その利用者の最後の1本は消せない。** ログイン手段はパスキーだけなので、
 * 消せてしまうと二度とログインできなくなる。件数は**その利用者の**パスキーで数える
 * （全体の件数で判定すると、他人がパスキーを持っているだけで最後の1本を消せてしまう）。
 *
 * 他人のパスキーのIDには、存在しないIDと同じ notFound を返す。
 *
 * ## なぜ対話型トランザクション + Serializable なのか
 *
 * 「件数を数える → 消してよいか判断する → 消す」を別々のクエリで実行すると、
 * 削除リクエストが2つ同時に来たときに**両方が同じ件数（例: 残り2本）を見て**
 * 両方とも削除に進み、資格情報が0本になり得る（＝締め出し）。
 *
 * **単に $transaction で囲んでも直らない。** PostgreSQL の既定の分離レベルは
 * Read Committed で、2つのトランザクションが互いのコミット前に count() を実行すれば
 * どちらも「残り2本」を見る（他トランザクションの未コミットの削除は見えない）。
 * count() が読んだ行の集合に対して他トランザクションの書き込みを検出させるには
 * **Serializable が必要**。競合した側は P2034 で失敗するので、それを握りつぶさず
 * 失敗として返す（下の catch）。
 */
export async function deleteCredential(
  client: PrismaClient,
  userId: UserId,
  id: string,
): Promise<PasskeyResult<null>> {
  try {
    return await client.$transaction(
      async (tx): Promise<PasskeyResult<null>> => {
        const target = await tx.credential.findFirst({ where: { id, userId } });
        if (!target) return { ok: false, error: PASSKEY_ERRORS.notFound };

        const totalCount = await tx.credential.count({ where: { userId } });
        const blocked = getCredentialDeleteBlockedReason(totalCount);
        // ここで返しても書き込みはまだ無いので、ロールバックされて困るものは無い
        if (blocked) return { ok: false, error: blocked };

        await tx.credential.delete({ where: { id, userId } });
        return { ok: true, value: null };
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    const code = getPrismaErrorCode(error);
    if (code === "P2025") {
      return { ok: false, error: PASSKEY_ERRORS.notFound };
    }
    // P2034 = write conflict / deadlock（直列化の失敗）。
    // 「成功したように見えて実は消えていない」を避けるため、必ず失敗として返す
    if (code === "P2034") {
      return { ok: false, error: PASSKEY_ERRORS.conflict };
    }
    throw error;
  }
}
