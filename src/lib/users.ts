import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { createCredential, type CreateCredentialInput } from "@/lib/credentials";
import { buildDemoData, getDemoExpiresAt } from "@/lib/demo-data";
import { recordDemoEvent } from "@/lib/demo-limits";
import { insertDemoData } from "@/lib/demo-seed";
import { getCurrentDate } from "@/lib/expense-date";
import { seedUserPresets, type SeedResult } from "@/lib/seed";
import { recordSignupEvent } from "@/lib/signup-limits";
import { brandUserIdFromTrustedSource, type UserId } from "@/lib/user-id";
import { generateWebauthnUserId, isValidWebauthnUserId } from "@/lib/webauthn-user-id";

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
 * 呼ぶのは下の createUserWithPresets / createUserWithPasskey / createDemoUser だけ。
 * demoExpiresAt を渡すのは createDemoUser だけ（渡さなければ通常のユーザー）。
 */
async function insertUserWithPresets(
  tx: Prisma.TransactionClient,
  webauthnUserId: string,
  options: { demoExpiresAt?: Date } = {},
): Promise<{ userId: UserId; presets: SeedResult }> {
  if (!isValidWebauthnUserId(webauthnUserId)) {
    throw new Error("invalid webauthnUserId");
  }
  const data: Prisma.UserCreateInput = { webauthnUserId };
  // デモユーザーだけが期限を持つ。通常のユーザー（サインアップ・検証スクリプト）は null のまま
  if (options.demoExpiresAt !== undefined) data.demoExpiresAt = options.demoExpiresAt;
  const user = await tx.user.create({ data, select: { id: true } });
  const userId = brandUserIdFromTrustedSource(user.id);
  const presets = await seedUserPresets(tx, userId);
  return { userId, presets };
}

/**
 * ユーザーを作り、同じトランザクションでプリセット（カテゴリ11件・払い出し先「現金」[既定]）を投入する。
 *
 * プリセットの投入に失敗したらユーザーも作られない（初期データの無いユーザーを残さない）。
 * パスキーを伴わないので、ログインできないユーザーになる。検証スクリプトで使う。
 * サインアップは createUserWithPasskey、デモアカウントは createDemoUser を使う。
 * **作るのは通常のユーザー（demoExpiresAt が null）。**
 *
 * @param webauthnUserId generateWebauthnUserId で作った値
 * @returns 作成したユーザーの ID
 * @throws webauthnUserId の形式が不正な場合 Error（何も作らない）
 */
export async function createUserWithPresets(
  client: PrismaClient,
  webauthnUserId: string,
): Promise<UserId> {
  return client.$transaction(
    async (tx) => (await insertUserWithPresets(tx, webauthnUserId)).userId,
  );
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
      const { userId: createdUserId } = await insertUserWithPresets(tx, input.webauthnUserId);

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

export type CreateDemoUserInput = {
  /** DemoEvent に記録する IP の HMAC */
  ipHash: string;
  /** 作成時刻。期限（demoExpiresAt）とサンプルデータの「今日」（JST）をここから決める */
  now: Date;
};

export type CreateDemoUserResult = {
  /** 今作ったデモユーザー。**セッションはこのユーザーにだけ発行する** */
  userId: UserId;
  /** そのユーザーの期限（User.demoExpiresAt と同じ値） */
  demoExpiresAt: Date;
};

/** デモユーザー作成のトランザクションの制限時間（ミリ秒）。サンプルデータの投入を含むので既定（5秒）より長くする */
export const DEMO_USER_TRANSACTION_TIMEOUT_MS = 20_000;

/**
 * デモユーザーを作る: **1つのトランザクションで**ユーザー（demoExpiresAt を設定）・プリセット・
 * サンプルデータ・DemoEvent を作る（docs/steps/pub-3.md 設計判断 1・3・8）。
 *
 * - **ユーザーを外から受け取らない。** 引数は IP の HMAC と時刻だけで、返すのは今作ったユーザーの ID だけ
 * - webauthnUserId は列の規則どおり generateWebauthnUserId で作る（デモではパスキーを登録させないが、例外にしない）
 * - demoExpiresAt は getDemoExpiresAt(now)（作成から DEMO_TTL_HOURS 時間後、秒に切り捨て）。以後変えない
 * - どれかが失敗したら全部を戻す（ユーザーも DemoEvent も残らない）。失敗は例外のまま投げる
 * - レート制限の確認は呼び出し側（startDemoAction）が**この関数を呼ぶ前に**行う
 */
export async function createDemoUser(
  client: PrismaClient,
  input: CreateDemoUserInput,
): Promise<CreateDemoUserResult> {
  const demoExpiresAt = getDemoExpiresAt(input.now);
  const plan = buildDemoData(getCurrentDate(input.now));
  const webauthnUserId = generateWebauthnUserId();

  const userId = await client.$transaction(
    async (tx) => {
      const created = await insertUserWithPresets(tx, webauthnUserId, { demoExpiresAt });
      await insertDemoData(tx, created.userId, plan, created.presets);
      await recordDemoEvent(tx, input.ipHash);
      return created.userId;
    },
    { timeout: DEMO_USER_TRANSACTION_TIMEOUT_MS },
  );
  return { userId, demoExpiresAt };
}

/**
 * その利用者がデモユーザーなら期限（demoExpiresAt）、通常のユーザーなら null。
 * 利用者の行が無い（削除された後のセッションなど）場合も null。
 *
 * User は利用者自身の行なので、`where: { id: userId }` で絞る。
 * 画面の表示（ダッシュボード・設定画面）とパスキー登録の拒否は、この DB の値で判定する。
 */
export async function findDemoExpiresAt(
  client: PrismaClient,
  userId: UserId,
): Promise<Date | null> {
  const user = await client.user.findFirst({
    where: { id: userId },
    select: { demoExpiresAt: true },
  });
  return user?.demoExpiresAt ?? null;
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
