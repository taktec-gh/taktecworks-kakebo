// @vitest-environment node
//
// src/lib/recovery-codes.ts のデータ層を検証する。実データベースには接続せず、
// PrismaClient をモックする（tests/lib/users.test.ts・tests/lib/credentials.test.ts と同じ方針）。
// createCredential（src/lib/credentials.ts）は高レベルにモックする
// （その内部の正しさは tests/lib/credentials.test.ts で検証済み）。
//
// 期待値の根拠:
// - docs/steps/pub-5.md 設計判断 2「ユーザーごとに一意の recoveryCodeHash」
// - docs/steps/pub-5.md 設計判断 4「コードの消費はパスキーの登録が済んだときに行う」
//   「新しいパスキーの登録と同じトランザクションでコードを差し替える。条件は
//   where: { id, recoveryCodeHash }。更新が1件でなければ失敗として全部を戻す」
// - docs/steps/pub-5.md「実装完了後の引き継ぎ」
//   「findRecoveryUserIdByCodeHash(client, hash)（where: { recoveryCodeHash, demoExpiresAt: null }。
//   形が不正なら DB を呼ばず null）、completeRecoveryWithPasskey(client, { userId, expectedCodeHash,
//   newCodeHash, credential }) → { ok: true } | { ok: false; reason: "duplicate" | "codeNotCurrent" }、
//   regenerateRecoveryCodeHash(client, userId, newHash): Promise<boolean>、hasRecoveryCode(client, userId)」
//   「completeRecoveryWithPasskey のトランザクション: 差し替え（updateMany({ where: { id: userId,
//   recoveryCodeHash: expectedCodeHash } })、count が1でなければ例外）→ createCredential(tx, ...) の順。
//   指示書の順（資格情報 → 差し替え）から逆にした」
// - docs/steps/pub-5.md「tester 向けの方針」2「更新が0件（先に使われた・作り直された）なら
//   資格情報も作られない」7「作り直し: requireUserId() の値で絞る」

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserId } from "@/lib/user-id";

const createCredential = vi.fn();
vi.mock("@/lib/credentials", () => ({
  createCredential: (...args: unknown[]) => createCredential(...args),
}));

const {
  completeRecoveryWithPasskey,
  findRecoveryUserIdByCodeHash,
  hasRecoveryCode,
  regenerateRecoveryCodeHash,
} = await import("@/lib/recovery-codes");

const USER_A = "user_a" as UserId;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_NEW = "c".repeat(64);
const INVALID_HASH = "not-a-hash";

const credentialInput = {
  credentialId: "cred-1",
  publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
  counter: 0,
  transports: ["internal"],
  deviceName: "iPhone",
};

function createMockClient() {
  const userFindFirst = vi.fn();
  const userUpdateMany = vi.fn();
  const tx = {
    user: { updateMany: userUpdateMany },
  };
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx));

  const client = {
    user: { findFirst: userFindFirst, updateMany: userUpdateMany },
    $transaction: transaction,
  } as unknown as PrismaClient;

  return { client, userFindFirst, userUpdateMany, transaction, tx };
}

beforeEach(() => {
  createCredential.mockReset();
});

describe("findRecoveryUserIdByCodeHash（コードの照合。ここではまだ消費しない）", () => {
  it("where は { recoveryCodeHash, demoExpiresAt: null } で、select は { id: true }", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue({ id: "user_a" });

    await findRecoveryUserIdByCodeHash(client, HASH_A);

    expect(userFindFirst).toHaveBeenCalledWith({
      where: { recoveryCodeHash: HASH_A, demoExpiresAt: null },
      select: { id: true },
    });
  });

  it("見つかれば id をそのまま返す", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue({ id: "user_a" });

    await expect(findRecoveryUserIdByCodeHash(client, HASH_A)).resolves.toBe("user_a");
  });

  it("見つからなければ null", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue(null);

    await expect(findRecoveryUserIdByCodeHash(client, HASH_A)).resolves.toBeNull();
  });

  it("ハッシュの形でない値は DB を呼ばず null（平文を照合に使わせない）", async () => {
    const { client, userFindFirst } = createMockClient();

    await expect(findRecoveryUserIdByCodeHash(client, INVALID_HASH)).resolves.toBeNull();
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("空文字も DB を呼ばず null", async () => {
    const { client, userFindFirst } = createMockClient();

    await expect(findRecoveryUserIdByCodeHash(client, "")).resolves.toBeNull();
    expect(userFindFirst).not.toHaveBeenCalled();
  });
});

describe("completeRecoveryWithPasskey（1トランザクションで差し替え→資格情報の作成。docs/steps/pub-5.md 設計判断 4）", () => {
  it("成功時: updateMany（差し替え）→ createCredential の順で同じトランザクション内に呼ばれ、{ ok: true } を返す", async () => {
    const { client, userUpdateMany, tx, transaction } = createMockClient();
    const order: string[] = [];
    userUpdateMany.mockImplementation(async () => {
      order.push("updateMany");
      return { count: 1 };
    });
    createCredential.mockImplementation(async () => {
      order.push("createCredential");
      return { ok: true, value: {} };
    });

    const result = await completeRecoveryWithPasskey(client, {
      userId: USER_A,
      expectedCodeHash: HASH_A,
      newCodeHash: HASH_NEW,
      credential: credentialInput,
    });

    expect(result).toEqual({ ok: true });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["updateMany", "createCredential"]);
    expect(createCredential).toHaveBeenCalledWith(tx, USER_A, credentialInput);
  });

  it("差し替えの where は { id: userId, recoveryCodeHash: expectedCodeHash }、data は { recoveryCodeHash: newCodeHash }（変異#3）", async () => {
    const { client, userUpdateMany } = createMockClient();
    userUpdateMany.mockResolvedValue({ count: 1 });
    createCredential.mockResolvedValue({ ok: true, value: {} });

    await completeRecoveryWithPasskey(client, {
      userId: USER_A,
      expectedCodeHash: HASH_A,
      newCodeHash: HASH_NEW,
      credential: credentialInput,
    });

    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: USER_A, recoveryCodeHash: HASH_A },
      data: { recoveryCodeHash: HASH_NEW },
    });
  });

  it("差し替えが0件（先に使われた・作り直された）なら { ok: false, reason: 'codeNotCurrent' } を返し、資格情報は作られない（tester 向けの方針 2）", async () => {
    const { client, userUpdateMany } = createMockClient();
    userUpdateMany.mockResolvedValue({ count: 0 });

    const result = await completeRecoveryWithPasskey(client, {
      userId: USER_A,
      expectedCodeHash: HASH_B, // もう自分のコードではない
      newCodeHash: HASH_NEW,
      credential: credentialInput,
    });

    expect(result).toEqual({ ok: false, reason: "codeNotCurrent" });
    expect(createCredential).not.toHaveBeenCalled();
  });

  it("差し替えの更新が2件以上（本来起きないはずだが）でも1件でなければ codeNotCurrent 扱い", async () => {
    const { client, userUpdateMany } = createMockClient();
    userUpdateMany.mockResolvedValue({ count: 2 });

    const result = await completeRecoveryWithPasskey(client, {
      userId: USER_A,
      expectedCodeHash: HASH_A,
      newCodeHash: HASH_NEW,
      credential: credentialInput,
    });

    expect(result).toEqual({ ok: false, reason: "codeNotCurrent" });
    expect(createCredential).not.toHaveBeenCalled();
  });

  it("資格情報の重複（createCredential が ok:false）なら { ok: false, reason: 'duplicate' } を返す（差し替えは行われたことになるが、呼び出し側がトランザクションごと戻す）", async () => {
    const { client, userUpdateMany } = createMockClient();
    userUpdateMany.mockResolvedValue({ count: 1 });
    createCredential.mockResolvedValue({ ok: false, error: "duplicate" });

    const result = await completeRecoveryWithPasskey(client, {
      userId: USER_A,
      expectedCodeHash: HASH_A,
      newCodeHash: HASH_NEW,
      credential: credentialInput,
    });

    expect(result).toEqual({ ok: false, reason: "duplicate" });
  });

  it("createCredential が例外を投げたらそのまま伝播する", async () => {
    const { client, userUpdateMany } = createMockClient();
    userUpdateMany.mockResolvedValue({ count: 1 });
    createCredential.mockRejectedValue(new Error("db unavailable"));

    await expect(
      completeRecoveryWithPasskey(client, {
        userId: USER_A,
        expectedCodeHash: HASH_A,
        newCodeHash: HASH_NEW,
        credential: credentialInput,
      }),
    ).rejects.toThrow("db unavailable");
  });

  it("expectedCodeHash がハッシュの形でなければ、トランザクションを始める前に throw する", async () => {
    const { client, transaction } = createMockClient();

    await expect(
      completeRecoveryWithPasskey(client, {
        userId: USER_A,
        expectedCodeHash: INVALID_HASH,
        newCodeHash: HASH_NEW,
        credential: credentialInput,
      }),
    ).rejects.toThrow("invalid recovery code hash");
    expect(transaction).not.toHaveBeenCalled();
    expect(createCredential).not.toHaveBeenCalled();
  });

  it("newCodeHash がハッシュの形でなければ（平文などを渡された場合）、トランザクションを始める前に throw する（変異#5）", async () => {
    const { client, transaction } = createMockClient();

    await expect(
      completeRecoveryWithPasskey(client, {
        userId: USER_A,
        expectedCodeHash: HASH_A,
        newCodeHash: "K7Q2M9XP4HTR8WNB3D6F", // 平文の形（20文字）
        credential: credentialInput,
      }),
    ).rejects.toThrow("invalid recovery code hash");
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("regenerateRecoveryCodeHash（設定画面からの作り直し。docs/steps/pub-5.md 設計判断 8）", () => {
  it("where は { id: userId } のみ（デモの判定は呼び出し側の責務）、data は { recoveryCodeHash: newHash }", async () => {
    const { client, userUpdateMany } = createMockClient();
    userUpdateMany.mockResolvedValue({ count: 1 });

    await regenerateRecoveryCodeHash(client, USER_A, HASH_NEW);

    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: USER_A },
      data: { recoveryCodeHash: HASH_NEW },
    });
  });

  it("1件更新できたら true", async () => {
    const { client, userUpdateMany } = createMockClient();
    userUpdateMany.mockResolvedValue({ count: 1 });

    await expect(regenerateRecoveryCodeHash(client, USER_A, HASH_NEW)).resolves.toBe(true);
  });

  it("0件（利用者の行が無い）なら false", async () => {
    const { client, userUpdateMany } = createMockClient();
    userUpdateMany.mockResolvedValue({ count: 0 });

    await expect(regenerateRecoveryCodeHash(client, USER_A, HASH_NEW)).resolves.toBe(false);
  });

  it("newHash がハッシュの形でなければ throw する（平文を保存しない）", async () => {
    const { client, userUpdateMany } = createMockClient();

    await expect(regenerateRecoveryCodeHash(client, USER_A, INVALID_HASH)).rejects.toThrow(
      "invalid recovery code hash",
    );
    expect(userUpdateMany).not.toHaveBeenCalled();
  });
});

describe("hasRecoveryCode（設定画面での発行済み表示。ハッシュそのものは返さない）", () => {
  it("where は { id: userId }、select は { recoveryCodeHash: true }", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue({ recoveryCodeHash: HASH_A });

    await hasRecoveryCode(client, USER_A);

    expect(userFindFirst).toHaveBeenCalledWith({
      where: { id: USER_A },
      select: { recoveryCodeHash: true },
    });
  });

  it("recoveryCodeHash が文字列なら true（発行済み）", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue({ recoveryCodeHash: HASH_A });

    await expect(hasRecoveryCode(client, USER_A)).resolves.toBe(true);
  });

  it("recoveryCodeHash が null なら false（未発行）", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue({ recoveryCodeHash: null });

    await expect(hasRecoveryCode(client, USER_A)).resolves.toBe(false);
  });

  it("行が無ければ false", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue(null);

    await expect(hasRecoveryCode(client, USER_A)).resolves.toBe(false);
  });

  it("戻り値にハッシュそのものを含まない（真偽値のみ）", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue({ recoveryCodeHash: HASH_A });

    const result = await hasRecoveryCode(client, USER_A);
    expect(result).toBe(true);
    expect(result).not.toBe(HASH_A);
  });
});
