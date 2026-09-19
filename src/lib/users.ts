import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { createCredential, type CreateCredentialInput } from "@/lib/credentials";
import { seedUserPresets } from "@/lib/seed";
import { recordSignupEvent } from "@/lib/signup-limits";
import { brandUserIdFromTrustedSource, type UserId } from "@/lib/user-id";
import { isValidWebauthnUserId } from "@/lib/webauthn-user-id";

/**
 * 利用者（User）の作成と、利用者自身の行の読み取り。
 *
 * **userId を取らない関数の例外**（docs/steps/pub-1.md 設計判断 6）。userId を生み出す側のため。
 * また、`brandUserIdFromTrustedSource` を呼んでよい3箇所の1つ（設計判断 7。サーバーが今作ったユーザー）。
 *
 * ユーザーIDを外部（フォーム・URL・Cookie）から受け取らない。ID は DB が採番する。
 * webauthnUserId は呼び出し側が src/lib/webauthn-user-id.ts の generateWebauthnUserId で作った値
 * （サインアップでは署名付き Cookie から取り出した値）を受け取る。
 */

/**
 * トランザクションの中でユーザーを作り、プリセットを投入する。
 *
 * export しない。トランザクションの外で呼ばれて「プリセットの無いユーザー」が残る経路を作らないため。
 * 呼ぶのは下の createUserWithPresets / createUserWithPasskey だけ。
 */
async function insertUserWithPresets(
  tx: Prisma.TransactionClient,
  webauthnUserId: string,
): Promise<UserId> {
  if (!isValidWebauthnUserId(webauthnUserId)) {
    throw new Error("invalid webauthnUserId");
  }
  const user = await tx.user.create({ data: { webauthnUserId }, select: { id: true } });
  const userId = brandUserIdFromTrustedSource(user.id);
  await seedUserPresets(tx, userId);
  return userId;
}

/**
 * ユーザーを作り、同じトランザクションでプリセット（カテゴリ11件・払い出し先「現金」[既定]）を投入する。
 *
 * プリセットの投入に失敗したらユーザーも作られない（初期データの無いユーザーを残さない）。
 * パスキーを伴わないので、ログインできないユーザーになる。検証スクリプトと、
 * 後の Step のデモアカウント作成で使う想定。サインアップは createUserWithPasskey を使う。
 *
 * @param webauthnUserId generateWebauthnUserId で作った値
 * @returns 作成したユーザーの ID
 * @throws webauthnUserId の形式が不正な場合 Error（何も作らない）
 */
export async function createUserWithPresets(
  client: PrismaClient,
  webauthnUserId: string,
): Promise<UserId> {
  return client.$transaction((tx) => insertUserWithPresets(tx, webauthnUserId));
}

export type CreateUserWithPasskeyInput = {
  /** 開始時に作り、署名付き Cookie で運んだ WebAuthn のユーザーID */
  webauthnUserId: string;
  /** 検証済みの登録応答から取り出した資格情報 */
  credential: CreateCredentialInput;
  /** SignupEvent に記録する IP の HMAC */
  ipHash: string;
};

export type CreateUserWithPasskeyResult =
  | { ok: true; userId: UserId }
  /** 同じ資格情報IDが登録済み（誰のものでも）。何も作られていない */
  | { ok: false; reason: "duplicate" };

/** トランザクションを戻すための内部の例外 */
class DuplicateCredentialError extends Error {
  constructor() {
    super("duplicate credential");
    this.name = "DuplicateCredentialError";
  }
}

/**
 * サインアップ: **1つのトランザクションで**ユーザー作成・プリセット投入・資格情報の保存・
 * サインアップの記録（SignupEvent）を行う（docs/steps/pub-2.md 設計判断 2・5）。
 *
 * どれかが失敗したら全部を戻す。資格情報の重複（P2002）でも、ユーザー・プリセット・
 * SignupEvent は1件も残らない。重複は `{ ok: false, reason: "duplicate" }`、
 * それ以外の失敗は例外のまま投げる（呼び出し側で一般的な失敗の文言にする）。
 *
 * 登録応答の検証は呼び出し側で**この関数を呼ぶ前に**済ませること。
 */
export async function createUserWithPasskey(
  client: PrismaClient,
  input: CreateUserWithPasskeyInput,
): Promise<CreateUserWithPasskeyResult> {
  try {
    const userId = await client.$transaction(async (tx) => {
      const createdUserId = await insertUserWithPresets(tx, input.webauthnUserId);

      const credential = await createCredential(tx, createdUserId, input.credential);
      // 失敗を戻り値で返すとトランザクションがコミットされてしまうので、例外で抜けて全部を戻す
      if (!credential.ok) throw new DuplicateCredentialError();

      await recordSignupEvent(tx, input.ipHash);
      return createdUserId;
    });
    return { ok: true, userId };
  } catch (error) {
    if (error instanceof DuplicateCredentialError) return { ok: false, reason: "duplicate" };
    throw error;
  }
}

/**
 * その利用者の webauthnUserId（設定画面での追加登録に使う）。利用者の行が無ければ null。
 *
 * User は利用者自身の行なので、`where: { id: userId }` で絞る（docs/steps/pub-2.md 設計判断 7）。
 */
export async function findWebauthnUserId(
  client: PrismaClient,
  userId: UserId,
): Promise<string | null> {
  const user = await client.user.findFirst({
    where: { id: userId },
    select: { webauthnUserId: true },
  });
  return user?.webauthnUserId ?? null;
}
