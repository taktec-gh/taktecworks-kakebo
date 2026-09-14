import type { Credential, PrismaClient } from "@/generated/prisma/client";

import {
  getCredentialDeleteBlockedReason,
  PASSKEY_ERRORS,
  type PasskeyResult,
} from "@/lib/passkey";

/**
 * パスキー（Credential）のデータ層。
 *
 * PrismaClient は引数で受け取る（src/lib/categories.ts と同じ方針。
 * テストからモックを差し込めるようにするため）。このモジュールはサーバー専用で、
 * Client Component から import しないこと（publicKey / counter を
 * ブラウザへ渡さないためでもある）。
 */

/** Prisma のエラーコードを取り出す（src/lib/categories.ts と同じ） */
function getPrismaErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** 登録順（古い順）。画面の一覧と excludeCredentials に使う */
export async function listCredentials(client: PrismaClient): Promise<Credential[]> {
  return client.credential.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

/**
 * 登録件数。**パスキー必須の判定はこの件数から導く**（docs/steps/step-7.md 設計判断1）。
 */
export async function countCredentials(client: PrismaClient): Promise<number> {
  return client.credential.count();
}

/** 認証器が返した資格情報ID（base64url）で1件引く。無ければ null */
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

/** 追加する。同じ資格情報IDが登録済みなら拒否する */
export async function createCredential(
  client: PrismaClient,
  input: CreateCredentialInput,
): Promise<PasskeyResult<Credential>> {
  try {
    const created = await client.credential.create({
      data: {
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
 * 削除する。
 *
 * パスキー必須の状態（RECOVERY_MODE 未設定）では**最後の1本を消せない**。
 * 消せてしまうと二度とログインできなくなるため
 * （docs/steps/step-7.md「設計判断 2. 締め出し対策」）。
 *
 * ## なぜ対話型トランザクション + Serializable なのか
 *
 * 「件数を数える → 消してよいか判断する → 消す」を別々のクエリで実行すると、
 * 削除リクエストが2つ同時に来たときに**両方が同じ件数（例: 残り2本）を見て**
 * 両方とも削除に進み、資格情報が0本になり得る。
 *
 * 0本になると shouldRequirePasskey() が false を返すので、結果は「締め出し」ではなく
 * **パスキー必須化の解除**＝パスワードだけで入れる状態への逆戻りになる。
 * つまり締め出し防止のガードそのものが競合で無効化される。
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
  id: string,
  recoveryMode: boolean,
): Promise<PasskeyResult<null>> {
  try {
    return await client.$transaction(
      async (tx): Promise<PasskeyResult<null>> => {
        const target = await tx.credential.findUnique({ where: { id } });
        if (!target) return { ok: false, error: PASSKEY_ERRORS.notFound };

        const totalCount = await tx.credential.count();
        const blocked = getCredentialDeleteBlockedReason(totalCount, recoveryMode);
        // ここで返しても書き込みはまだ無いので、ロールバックされて困るものは無い
        if (blocked) return { ok: false, error: blocked };

        await tx.credential.delete({ where: { id } });
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
