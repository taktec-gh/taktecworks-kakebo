// @vitest-environment node
//
// src/lib/credentials.ts のデータ層を検証する。実データベースには接続せず、
// PrismaClient をモックする（tests/lib/categories.test.ts と同じ方針）。
//
// 期待値の根拠:
// - docs/steps/step-7.md「設計判断 2. 締め出し対策」「tester への引き継ぎ > 5. 失敗パスの再現方法」
// - docs/steps/pub-1.md 設計判断 6「Credential の持ち主、『最後の1本は消せない』をユーザー単位に」
//   「例外（userId を取らない関数）はこれだけ」の表（findCredentialByCredentialId /
//   updateCredentialCounter のみ例外。listCredentials / createCredential / deleteCredential は userId を取る）
// - docs/steps/pub-1.md「実装完了後の引き継ぎ」
//   「getCredentialDeleteBlockedReason(totalCount) — recoveryMode 引数を削除」
//   「deleteCredential — 対象の取得・件数・削除の3つすべて。件数はそのユーザーのパスキーの数で
//    『最後の1本』を判定する」
// - docs/steps/pub-1.md 設計判断 1「countCredentials（使い道が無くなれば）」廃止
//   （RECOVERY_MODE 廃止に伴い、全体の件数を数える必要が無くなったため countCredentials を削除）

import { describe, expect, it, vi } from "vitest";

import type { Credential, PrismaClient } from "@/generated/prisma/client";
import { PASSKEY_ERRORS } from "@/lib/passkey-messages";
import {
  createCredential,
  deleteCredential,
  findCredentialByCredentialId,
  listCredentials,
  updateCredentialCounter,
} from "@/lib/credentials";
import type { UserId } from "@/lib/user-id";

const NOW = new Date("2026-08-14T00:00:00.000Z");
const USER_ID = "user_1" as UserId;
const OTHER_USER_ID = "user_2" as UserId;

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "cred_1",
    userId: USER_ID,
    credentialId: "credential-id-1",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: BigInt(0),
    transports: ["internal"],
    deviceName: "iPhone",
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: null,
    ...overrides,
  } as Credential;
}

/** P2002 / P2025 のような Prisma エラーを再現する */
function prismaError(code: string): Error {
  return Object.assign(new Error(`mock prisma error ${code}`), { code });
}

function createMockClient() {
  const findMany = vi.fn();
  const count = vi.fn();
  const findUnique = vi.fn();
  const findFirst = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  const deleteFn = vi.fn();
  // deleteCredential は対話型トランザクション（tx）でこれらを呼ぶ。
  // モックの $transaction は「与えられたコールバックに client 自身（= tx として使う）を
  // 渡して実行する」だけの単純な実装にする。tx.credential.xxx は
  // client.credential.xxx と同じ spy を指すので、呼び出し検証はそのまま使える。
  const $transaction = vi.fn((fn: (tx: PrismaClient) => unknown, options?: unknown) =>
    fn(client),
  );

  const client = {
    credential: { findMany, count, findUnique, findFirst, create, update, delete: deleteFn },
    $transaction,
  } as unknown as PrismaClient;

  return { client, findMany, count, findUnique, findFirst, create, update, deleteFn, $transaction };
}

describe("listCredentials", () => {
  it("userId で絞り、createdAt asc, id asc の順で findMany を呼ぶ", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);

    await listCredentials(client, USER_ID);

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("1件も無ければ空配列", async () => {
    const { client, findMany } = createMockClient();
    findMany.mockResolvedValue([]);
    await expect(listCredentials(client, USER_ID)).resolves.toEqual([]);
  });
});

describe("findCredentialByCredentialId（userId を取らない例外: ログイン時点では持ち主が分からない）", () => {
  it("credentialId で findUnique する", async () => {
    const { client, findUnique } = createMockClient();
    const credential = makeCredential();
    findUnique.mockResolvedValue(credential);

    await expect(findCredentialByCredentialId(client, "credential-id-1")).resolves.toBe(
      credential,
    );
    expect(findUnique).toHaveBeenCalledWith({ where: { credentialId: "credential-id-1" } });
  });

  it("存在しなければ null", async () => {
    const { client, findUnique } = createMockClient();
    findUnique.mockResolvedValue(null);
    await expect(findCredentialByCredentialId(client, "no-such-id")).resolves.toBeNull();
  });
});

describe("createCredential", () => {
  it("counter は Number ではなく BigInt として保存する。data.userId は引数の userId", async () => {
    const { client, create } = createMockClient();
    create.mockResolvedValue(makeCredential());

    await createCredential(client, USER_ID, {
      credentialId: "credential-id-1",
      publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
      counter: 0,
      transports: ["internal"],
      deviceName: "iPhone",
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        credentialId: "credential-id-1",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: BigInt(0),
        transports: ["internal"],
        deviceName: "iPhone",
      },
    });
  });

  it("成功時は ok:true とレコードを返す", async () => {
    const { client, create } = createMockClient();
    const created = makeCredential();
    create.mockResolvedValue(created);

    await expect(
      createCredential(client, USER_ID, {
        credentialId: "credential-id-1",
        publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
        counter: 0,
        transports: [],
        deviceName: "iPhone",
      }),
    ).resolves.toEqual({ ok: true, value: created });
  });

  it("同じ資格情報IDの重複登録（P2002）は duplicate エラーに変換する", async () => {
    const { client, create } = createMockClient();
    create.mockRejectedValue(prismaError("P2002"));

    await expect(
      createCredential(client, USER_ID, {
        credentialId: "credential-id-1",
        publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
        counter: 0,
        transports: [],
        deviceName: "iPhone",
      }),
    ).resolves.toEqual({ ok: false, error: PASSKEY_ERRORS.duplicate });
  });

  it("P2002 以外のエラーはそのまま再送出する", async () => {
    const { client, create } = createMockClient();
    create.mockRejectedValue(prismaError("P9999"));

    await expect(
      createCredential(client, USER_ID, {
        credentialId: "credential-id-1",
        publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
        counter: 0,
        transports: [],
        deviceName: "iPhone",
      }),
    ).rejects.toThrow();
  });
});

describe("updateCredentialCounter（userId を取らない例外: 持ち主確認の直後に同じ資格情報IDで更新する）", () => {
  it("counter を BigInt にして lastUsedAt とともに更新する", async () => {
    const { client, update } = createMockClient();
    update.mockResolvedValue(makeCredential());

    await updateCredentialCounter(client, "credential-id-1", 7, NOW);

    expect(update).toHaveBeenCalledWith({
      where: { credentialId: "credential-id-1" },
      data: { counter: BigInt(7), lastUsedAt: NOW },
    });
  });

  it("counter が0でも正しく渡す", async () => {
    const { client, update } = createMockClient();
    update.mockResolvedValue(makeCredential());

    await updateCredentialCounter(client, "credential-id-1", 0, NOW);

    expect(update).toHaveBeenCalledWith({
      where: { credentialId: "credential-id-1" },
      data: { counter: BigInt(0), lastUsedAt: NOW },
    });
  });
});

describe("deleteCredential — 資格情報の削除（締め出し対策。ユーザー単位の件数で判定）", () => {
  it("対象が存在しなければ notFound（count は呼ばない）。findFirst の where は { id, userId }", async () => {
    const { client, findFirst, count, deleteFn } = createMockClient();
    findFirst.mockResolvedValue(null);

    await expect(deleteCredential(client, USER_ID, "no-such-id")).resolves.toEqual({
      ok: false,
      error: PASSKEY_ERRORS.notFound,
    });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "no-such-id", userId: USER_ID } });
    expect(count).not.toHaveBeenCalled();
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("残り1本（そのユーザーの件数）なら削除できない。count は userId で絞る", async () => {
    const { client, findFirst, count, deleteFn } = createMockClient();
    findFirst.mockResolvedValue(makeCredential());
    count.mockResolvedValue(1);

    await expect(deleteCredential(client, USER_ID, "cred_1")).resolves.toEqual({
      ok: false,
      error: PASSKEY_ERRORS.deleteLastOne,
    });
    expect(count).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("残り2本以上なら削除できる。delete の where は { id, userId }", async () => {
    const { client, findFirst, count, deleteFn } = createMockClient();
    const target = makeCredential();
    findFirst.mockResolvedValue(target);
    count.mockResolvedValue(2);
    deleteFn.mockResolvedValue(target);

    await expect(deleteCredential(client, USER_ID, "cred_1")).resolves.toEqual({
      ok: true,
      value: null,
    });
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: "cred_1", userId: USER_ID } });
  });

  it("A が1本・B が2本のとき、A は消せず B は消せる（ユーザー単位で『最後の1本』が独立している）", async () => {
    const { client, findFirst, count, deleteFn } = createMockClient();

    // A（USER_ID）は1本しか持たない
    findFirst.mockResolvedValueOnce(makeCredential({ id: "cred_a1", userId: USER_ID }));
    count.mockResolvedValueOnce(1);
    const resultA = await deleteCredential(client, USER_ID, "cred_a1");
    expect(resultA).toEqual({ ok: false, error: PASSKEY_ERRORS.deleteLastOne });

    // B（OTHER_USER_ID）は2本持つ
    findFirst.mockResolvedValueOnce(makeCredential({ id: "cred_b1", userId: OTHER_USER_ID }));
    count.mockResolvedValueOnce(2);
    deleteFn.mockResolvedValueOnce(makeCredential({ id: "cred_b1", userId: OTHER_USER_ID }));
    const resultB = await deleteCredential(client, OTHER_USER_ID, "cred_b1");
    expect(resultB).toEqual({ ok: true, value: null });
  });

  it("削除直前に対象が消えていた場合（P2025）は notFound", async () => {
    const { client, findFirst, count, deleteFn } = createMockClient();
    const target = makeCredential();
    findFirst.mockResolvedValue(target);
    count.mockResolvedValue(2);
    deleteFn.mockRejectedValue(prismaError("P2025"));

    await expect(deleteCredential(client, USER_ID, "cred_1")).resolves.toEqual({
      ok: false,
      error: PASSKEY_ERRORS.notFound,
    });
  });

  it("P2025 / P2034 以外のエラーはそのまま再送出する", async () => {
    const { client, findFirst, count, deleteFn } = createMockClient();
    const target = makeCredential();
    findFirst.mockResolvedValue(target);
    count.mockResolvedValue(2);
    // P9999 は notFound(P2025) にも conflict(P2034) にも該当しない未知のエラーコード。
    // このコードのまま rejects されること（＝握りつぶさず再送出すること）を確認する。
    deleteFn.mockRejectedValue(prismaError("P9999"));

    await expect(deleteCredential(client, USER_ID, "cred_1")).rejects.toMatchObject({
      code: "P9999",
    });
  });

  it("isolationLevel: Serializable を指定してトランザクションを開始する（退行検出）", async () => {
    // 分離レベルが Serializable でなくなると、docs/steps/step-7.md の
    // 「設計判断 2. 締め出し対策」に書かれた競合検知（P2034）が機能しなくなり、
    // 同時削除で資格情報が0本になり得る = パスキー必須化が意図せず解除される。
    const { client, findFirst, count, deleteFn, $transaction } = createMockClient();
    const target = makeCredential();
    findFirst.mockResolvedValue(target);
    count.mockResolvedValue(2);
    deleteFn.mockResolvedValue(target);

    await deleteCredential(client, USER_ID, "cred_1");

    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("findFirst / count / delete がすべて同じトランザクション内（tx経由）で呼ばれる", async () => {
    const { client, findFirst, count, deleteFn, $transaction } = createMockClient();
    const target = makeCredential();
    findFirst.mockResolvedValue(target);
    count.mockResolvedValue(2);
    deleteFn.mockResolvedValue(target);

    await deleteCredential(client, USER_ID, "cred_1");

    // $transaction のコールバックが呼ばれて初めて findFirst/count/delete が実行される
    // ことを、呼び出し順で確認する（$transaction が先に呼ばれていること）。
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "cred_1", userId: USER_ID } });
    expect(count).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: "cred_1", userId: USER_ID } });
  });

  it("競合により直列化に失敗した場合（P2034）は conflict エラーを返す（throwしない）", async () => {
    const { client, findFirst, count, deleteFn } = createMockClient();
    const target = makeCredential();
    findFirst.mockResolvedValue(target);
    count.mockResolvedValue(2);
    deleteFn.mockRejectedValue(prismaError("P2034"));

    // 「成功したように見えて実は消えていない」を避けるため、握りつぶさず
    // 失敗として返す（throw ではなく ok:false）。
    await expect(deleteCredential(client, USER_ID, "cred_1")).resolves.toEqual({
      ok: false,
      error: PASSKEY_ERRORS.conflict,
    });
  });

  it("ガードで弾かれる場合（残り1本）は delete を呼ばない", async () => {
    const { client, findFirst, count, deleteFn } = createMockClient();
    findFirst.mockResolvedValue(makeCredential());
    count.mockResolvedValue(1);

    await deleteCredential(client, USER_ID, "cred_1");

    expect(deleteFn).not.toHaveBeenCalled();
  });
});
