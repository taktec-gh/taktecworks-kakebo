// @vitest-environment node
//
// src/lib/users.ts の createUserWithPresets / createUserWithPasskey / findWebauthnUserId を検証する。
// 実データベースには接続せず、PrismaClient と @/lib/seed・@/lib/credentials・@/lib/signup-limits をモックする。
//
// 期待値の根拠:
// - docs/steps/pub-2.md 設計判断 2「サインアップの途中離脱」
//   「finishSignupAction: 通ったら1つのトランザクションでユーザー作成・プリセット投入・
//   資格情報の保存・サインアップの記録（設計判断 5）を行い、そのユーザーのセッションを発行する。
//   どれかが失敗したら全部を戻す」
// - docs/steps/pub-2.md「実装内容 > 2. ライブラリ」
//   「ユーザー作成（users.ts）: webauthnUserId と資格情報を受け取り、1つのトランザクションで
//   ユーザー・プリセット・資格情報・SignupEvent を作る。createUserWithPresets のシグネチャも
//   webauthnUserId を受け取る形に変わる」
// - docs/steps/pub-2.md「実装完了後の引き継ぎ」
//   「createUserWithPresets(client, webauthnUserId)（シグネチャ変更）、
//   createUserWithPasskey(client, { webauthnUserId, credential, ipHash }) →
//   { ok: true, userId } | { ok: false, reason: "duplicate" }（1トランザクションで
//   User → プリセット → 資格情報 → SignupEvent）、findWebauthnUserId(client, userId)」
// - docs/steps/pub-2.md 設計判断 7「webauthnUserId の取得は userId で絞る
//   （where: { id: userId }。User は自分自身の行）」
// - docs/steps/pub-1.md 設計判断 7「呼び出してよい場所」の1つ
//   （ユーザーを作る関数 = サーバーが今作ったユーザーの ID を brand してよい）
// - design-decisions.md「ユーザーIDを外部（フォーム・URL・Cookie）から受け取らない。
//   ID は DB が採番する」→ tx.user.create の data は { webauthnUserId } だけであること
//   （外部から渡された id を書き込まない）

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import type { UserId } from "@/lib/user-id";

// 32バイトの暗号学的乱数を base64url にした値（node:crypto で手元生成した固定値。
// isValidWebauthnUserId が要求する形式: 43文字・base64url・32バイトに戻る）
const VALID_WEBAUTHN_USER_ID = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const OTHER_VALID_WEBAUTHN_USER_ID = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA";

// リカバリーコードのハッシュの形（isRecoveryCodeHash が要求する /^[0-9a-f]{64}$/）。
// docs/steps/pub-5.md 設計判断 2・実装完了後の引き継ぎ:
// 「CreateUserWithPasskeyInput に recoveryCodeHash（必須。形が不正ならトランザクション前に例外）」
const VALID_RECOVERY_CODE_HASH = "a".repeat(64);
const INVALID_RECOVERY_CODE_HASH = "not-a-hash";

const seedUserPresets = vi.fn();
vi.mock("@/lib/seed", () => ({
  seedUserPresets: (...args: unknown[]) => seedUserPresets(...args),
}));

const createCredential = vi.fn();
vi.mock("@/lib/credentials", () => ({
  createCredential: (...args: unknown[]) => createCredential(...args),
}));

const recordSignupEvent = vi.fn();
vi.mock("@/lib/signup-limits", () => ({
  recordSignupEvent: (...args: unknown[]) => recordSignupEvent(...args),
}));

// ---- デモアカウント関連のモック（docs/steps/pub-3.md）----
const buildDemoData = vi.fn();
const getDemoExpiresAt = vi.fn();
vi.mock("@/lib/demo-data", () => ({
  buildDemoData: (...args: unknown[]) => buildDemoData(...args),
  getDemoExpiresAt: (...args: unknown[]) => getDemoExpiresAt(...args),
}));

const recordDemoEvent = vi.fn();
vi.mock("@/lib/demo-limits", () => ({
  recordDemoEvent: (...args: unknown[]) => recordDemoEvent(...args),
}));

const insertDemoData = vi.fn();
vi.mock("@/lib/demo-seed", () => ({
  insertDemoData: (...args: unknown[]) => insertDemoData(...args),
}));

const {
  createUserWithPresets,
  createUserWithPasskey,
  createDemoUser,
  findWebauthnUserId,
  findDemoExpiresAt,
  DEMO_USER_TRANSACTION_TIMEOUT_MS,
} = await import("@/lib/users");

beforeEach(() => {
  seedUserPresets.mockReset();
  createCredential.mockReset();
  recordSignupEvent.mockReset();
  buildDemoData.mockReset();
  getDemoExpiresAt.mockReset();
  recordDemoEvent.mockReset();
  insertDemoData.mockReset();
});

function createMockClient() {
  const userCreate = vi.fn();
  const userFindFirst = vi.fn();
  const tx = {
    user: { create: userCreate },
  };
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx));

  const client = {
    user: { findFirst: userFindFirst },
    $transaction: transaction,
  } as unknown as PrismaClient;

  return { client, userCreate, userFindFirst, transaction, tx };
}

describe("createUserWithPresets", () => {
  it("User を data: { webauthnUserId } で作る（外部から id を渡さない。ID は DB が採番する）", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await createUserWithPresets(client, VALID_WEBAUTHN_USER_ID);

    expect(userCreate).toHaveBeenCalledWith({
      data: { webauthnUserId: VALID_WEBAUTHN_USER_ID },
      select: { id: true },
    });
  });

  it("webauthnUserId の形式が不正なら throw し、User を作らない", async () => {
    const { client, userCreate } = createMockClient();

    await expect(createUserWithPresets(client, "not-a-valid-webauthn-user-id")).rejects.toThrow(
      "invalid webauthnUserId",
    );
    expect(userCreate).not.toHaveBeenCalled();
    expect(seedUserPresets).not.toHaveBeenCalled();
  });

  it("作成した User の id を UserId として seedUserPresets に渡す", async () => {
    const { client, userCreate, tx } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_42" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await createUserWithPresets(client, VALID_WEBAUTHN_USER_ID);

    expect(seedUserPresets).toHaveBeenCalledWith(tx, "user_42");
  });

  it("User 作成とプリセット投入が同じトランザクション（$transaction のコールバック内）で行われる", async () => {
    const { client, userCreate, transaction } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await createUserWithPresets(client, VALID_WEBAUTHN_USER_ID);

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("戻り値は作成したユーザーの id", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_99" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await expect(createUserWithPresets(client, VALID_WEBAUTHN_USER_ID)).resolves.toBe("user_99");
  });

  it("User の id が空文字なら（ブランド化に失敗し）throw する。プリセットの投入は行われない", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "" });

    await expect(createUserWithPresets(client, VALID_WEBAUTHN_USER_ID)).rejects.toThrow();
    expect(seedUserPresets).not.toHaveBeenCalled();
  });

  it("プリセット投入が失敗したら例外がそのまま伝播する（同一トランザクションなのでユーザーも作られない）", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockRejectedValue(new Error("preset failed"));

    await expect(createUserWithPresets(client, VALID_WEBAUTHN_USER_ID)).rejects.toThrow(
      "preset failed",
    );
  });
});

describe("createUserWithPasskey（サインアップ: 1トランザクションで User → プリセット → 資格情報 → SignupEvent）", () => {
  const credentialInput = {
    credentialId: "cred-1",
    publicKey: new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>,
    counter: 0,
    transports: ["internal"],
    deviceName: "iPhone",
  };

  it("成功時: User作成 → createCredential → recordSignupEvent の順で同じトランザクション内に呼ばれ、{ ok: true, userId } を返す", async () => {
    const { client, userCreate, tx, transaction } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });
    const order: string[] = [];
    seedUserPresets.mockImplementation(async () => {
      order.push("seedUserPresets");
    });
    createCredential.mockImplementation(async () => {
      order.push("createCredential");
      return { ok: true, value: {} };
    });
    recordSignupEvent.mockImplementation(async () => {
      order.push("recordSignupEvent");
    });

    const result = await createUserWithPasskey(client, {
      webauthnUserId: VALID_WEBAUTHN_USER_ID,
      credential: credentialInput,
      ipHash: "iphash-1",
      recoveryCodeHash: VALID_RECOVERY_CODE_HASH,
    });

    expect(result).toEqual({ ok: true, userId: "user_1" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["seedUserPresets", "createCredential", "recordSignupEvent"]);
    expect(createCredential).toHaveBeenCalledWith(tx, "user_1", credentialInput);
    expect(recordSignupEvent).toHaveBeenCalledWith(tx, "iphash-1");
  });

  it("資格情報の重複（createCredential が ok:false）なら { ok: false, reason: 'duplicate' } を返し、recordSignupEvent は呼ばれない", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });
    createCredential.mockResolvedValue({ ok: false, error: "duplicate" });

    const result = await createUserWithPasskey(client, {
      webauthnUserId: VALID_WEBAUTHN_USER_ID,
      credential: credentialInput,
      ipHash: "iphash-1",
      recoveryCodeHash: VALID_RECOVERY_CODE_HASH,
    });

    expect(result).toEqual({ ok: false, reason: "duplicate" });
    expect(recordSignupEvent).not.toHaveBeenCalled();
  });

  it("createCredential が P2002 以外の例外を投げたらそのまま伝播する（duplicate に変換しない）", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });
    createCredential.mockRejectedValue(new Error("db unavailable"));

    await expect(
      createUserWithPasskey(client, {
        webauthnUserId: VALID_WEBAUTHN_USER_ID,
        credential: credentialInput,
        ipHash: "iphash-1",
        recoveryCodeHash: VALID_RECOVERY_CODE_HASH,
      }),
    ).rejects.toThrow("db unavailable");
    expect(recordSignupEvent).not.toHaveBeenCalled();
  });

  it("プリセット投入が失敗したら例外が伝播し、createCredential・recordSignupEvent は呼ばれない（途中離脱でユーザーを残さない）", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockRejectedValue(new Error("preset failed"));

    await expect(
      createUserWithPasskey(client, {
        webauthnUserId: VALID_WEBAUTHN_USER_ID,
        credential: credentialInput,
        ipHash: "iphash-1",
        recoveryCodeHash: VALID_RECOVERY_CODE_HASH,
      }),
    ).rejects.toThrow("preset failed");
    expect(createCredential).not.toHaveBeenCalled();
    expect(recordSignupEvent).not.toHaveBeenCalled();
  });

  it("Cookie から取り出した webauthnUserId をそのまま User の作成に使う（別の値を作らない）", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });
    createCredential.mockResolvedValue({ ok: true, value: {} });

    await createUserWithPasskey(client, {
      webauthnUserId: OTHER_VALID_WEBAUTHN_USER_ID,
      credential: credentialInput,
      ipHash: "iphash-1",
      recoveryCodeHash: VALID_RECOVERY_CODE_HASH,
    });

    expect(userCreate).toHaveBeenCalledWith({
      data: {
        webauthnUserId: OTHER_VALID_WEBAUTHN_USER_ID,
        recoveryCodeHash: VALID_RECOVERY_CODE_HASH,
      },
      select: { id: true },
    });
  });

  it("recoveryCodeHash がハッシュの形でなければ、トランザクションを始める前に throw し、何も呼ばれない（docs/steps/pub-5.md 設計判断 2「平文はどこにも保存しない」）", async () => {
    const { client, userCreate, transaction } = createMockClient();

    await expect(
      createUserWithPasskey(client, {
        webauthnUserId: VALID_WEBAUTHN_USER_ID,
        credential: credentialInput,
        ipHash: "iphash-1",
        recoveryCodeHash: INVALID_RECOVERY_CODE_HASH,
      }),
    ).rejects.toThrow("invalid recovery code hash");

    expect(transaction).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
    expect(seedUserPresets).not.toHaveBeenCalled();
    expect(createCredential).not.toHaveBeenCalled();
    expect(recordSignupEvent).not.toHaveBeenCalled();
  });

  it("recoveryCodeHash が空文字なら throw する（未発行のまま保存しない）", async () => {
    await expect(
      createUserWithPasskey(client(), {
        webauthnUserId: VALID_WEBAUTHN_USER_ID,
        credential: credentialInput,
        ipHash: "iphash-1",
        recoveryCodeHash: "",
      }),
    ).rejects.toThrow("invalid recovery code hash");

    function client() {
      return createMockClient().client;
    }
  });

  it("User の作成データに recoveryCodeHash（渡したハッシュそのまま）が含まれる", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_1" });
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });
    createCredential.mockResolvedValue({ ok: true, value: {} });

    await createUserWithPasskey(client, {
      webauthnUserId: VALID_WEBAUTHN_USER_ID,
      credential: credentialInput,
      ipHash: "iphash-1",
      recoveryCodeHash: VALID_RECOVERY_CODE_HASH,
    });

    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recoveryCodeHash: VALID_RECOVERY_CODE_HASH }),
      }),
    );
  });
});

describe("createDemoUser（デモ: 1トランザクションで User(demoExpiresAt) → プリセット → サンプルデータ → DemoEvent。docs/steps/pub-3.md 設計判断 1・3・8）", () => {
  const NOW = new Date("2026-08-14T00:00:00.000Z");
  const EXPIRES_AT = new Date("2026-08-15T00:00:00.000Z");
  const PLAN = { yearMonths: ["2026-08"], paymentSources: [], budgets: [], categoryBudgets: [], incomes: [], expenses: [] };

  it("成功時: buildDemoData(getCurrentDate(now)) → User作成(demoExpiresAt付き) → insertDemoData → recordDemoEvent の順で1トランザクション内に呼ばれ、{ userId, demoExpiresAt } を返す", async () => {
    const { client, userCreate, tx, transaction } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_demo_1" });
    getDemoExpiresAt.mockReturnValue(EXPIRES_AT);
    buildDemoData.mockReturnValue(PLAN);
    const presets = { categories: [{ id: "cat_1" }], paymentSources: [{ id: "ps_1" }] };
    seedUserPresets.mockResolvedValue(presets);
    const order: string[] = [];
    seedUserPresets.mockImplementation(async () => {
      order.push("seedUserPresets");
      return presets;
    });
    insertDemoData.mockImplementation(async () => {
      order.push("insertDemoData");
    });
    recordDemoEvent.mockImplementation(async () => {
      order.push("recordDemoEvent");
    });

    const result = await createDemoUser(client, { ipHash: "iphash-1", now: NOW });

    expect(result).toEqual({ userId: "user_demo_1", demoExpiresAt: EXPIRES_AT });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["seedUserPresets", "insertDemoData", "recordDemoEvent"]);
    // getCurrentDate(NOW) = JST の日付。2026-08-14T00:00:00Z は JST 2026-08-14 09:00 → "2026-08-14"
    expect(buildDemoData).toHaveBeenCalledWith("2026-08-14");
    expect(getDemoExpiresAt).toHaveBeenCalledWith(NOW);
    expect(insertDemoData).toHaveBeenCalledWith(tx, "user_demo_1", PLAN, presets);
    expect(recordDemoEvent).toHaveBeenCalledWith(tx, "iphash-1");
  });

  it("作成する User の data に demoExpiresAt が含まれる（getDemoExpiresAt の戻り値）。通常ユーザーとの違いはここだけ", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_demo_1" });
    getDemoExpiresAt.mockReturnValue(EXPIRES_AT);
    buildDemoData.mockReturnValue(PLAN);
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await createDemoUser(client, { ipHash: "iphash-1", now: NOW });

    expect(userCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ demoExpiresAt: EXPIRES_AT }),
      select: { id: true },
    });
  });

  it("webauthnUserId は generateWebauthnUserId が作った値（呼び出しごとに違う値。isValidWebauthnUserId を満たす）", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_demo_1" });
    getDemoExpiresAt.mockReturnValue(EXPIRES_AT);
    buildDemoData.mockReturnValue(PLAN);
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await createDemoUser(client, { ipHash: "iphash-1", now: NOW });
    const firstCallData = userCreate.mock.calls[0][0].data as { webauthnUserId: string };

    userCreate.mockClear();
    await createDemoUser(client, { ipHash: "iphash-2", now: NOW });
    const secondCallData = userCreate.mock.calls[0][0].data as { webauthnUserId: string };

    expect(firstCallData.webauthnUserId.length).toBeGreaterThan(0);
    expect(firstCallData.webauthnUserId).not.toBe(secondCallData.webauthnUserId);
  });

  it("トランザクションに timeout オプション（DEMO_USER_TRANSACTION_TIMEOUT_MS）を渡す", async () => {
    const { client, userCreate, transaction } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_demo_1" });
    getDemoExpiresAt.mockReturnValue(EXPIRES_AT);
    buildDemoData.mockReturnValue(PLAN);
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });

    await createDemoUser(client, { ipHash: "iphash-1", now: NOW });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: DEMO_USER_TRANSACTION_TIMEOUT_MS,
    });
    expect(DEMO_USER_TRANSACTION_TIMEOUT_MS).toBeGreaterThan(5000); // 既定の5秒より長い
  });

  it("プリセット投入が失敗したら例外が伝播し、insertDemoData・recordDemoEvent は呼ばれない（ユーザーだけが残る経路を作らない）", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_demo_1" });
    getDemoExpiresAt.mockReturnValue(EXPIRES_AT);
    buildDemoData.mockReturnValue(PLAN);
    seedUserPresets.mockRejectedValue(new Error("preset failed"));

    await expect(createDemoUser(client, { ipHash: "iphash-1", now: NOW })).rejects.toThrow(
      "preset failed",
    );
    expect(insertDemoData).not.toHaveBeenCalled();
    expect(recordDemoEvent).not.toHaveBeenCalled();
  });

  it("サンプルデータの投入（insertDemoData）が失敗したら例外が伝播し、recordDemoEvent は呼ばれない（ユーザー・プリセットも巻き戻る想定）", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_demo_1" });
    getDemoExpiresAt.mockReturnValue(EXPIRES_AT);
    buildDemoData.mockReturnValue(PLAN);
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });
    insertDemoData.mockRejectedValue(new Error("insert failed"));

    await expect(createDemoUser(client, { ipHash: "iphash-1", now: NOW })).rejects.toThrow(
      "insert failed",
    );
    expect(recordDemoEvent).not.toHaveBeenCalled();
  });

  it("DemoEvent の記録（recordDemoEvent）が失敗したら例外が伝播する", async () => {
    const { client, userCreate } = createMockClient();
    userCreate.mockResolvedValue({ id: "user_demo_1" });
    getDemoExpiresAt.mockReturnValue(EXPIRES_AT);
    buildDemoData.mockReturnValue(PLAN);
    seedUserPresets.mockResolvedValue({ categories: [], paymentSources: [] });
    recordDemoEvent.mockRejectedValue(new Error("record failed"));

    await expect(createDemoUser(client, { ipHash: "iphash-1", now: NOW })).rejects.toThrow(
      "record failed",
    );
  });
});

describe("findWebauthnUserId（userId で絞る。User は自分自身の行。設計判断 7）", () => {
  it("findFirst の where は { id: userId } で呼ぶ", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue({ webauthnUserId: VALID_WEBAUTHN_USER_ID });

    await findWebauthnUserId(client, "user_1" as UserId);

    expect(userFindFirst).toHaveBeenCalledWith({
      where: { id: "user_1" },
      select: { webauthnUserId: true },
    });
  });

  it("見つかった webauthnUserId を返す", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue({ webauthnUserId: VALID_WEBAUTHN_USER_ID });

    await expect(findWebauthnUserId(client, "user_1" as UserId)).resolves.toBe(
      VALID_WEBAUTHN_USER_ID,
    );
  });

  it("行が無ければ null", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue(null);

    await expect(findWebauthnUserId(client, "user_ghost" as UserId)).resolves.toBeNull();
  });
});

describe("findDemoExpiresAt（userId で絞る。デモ判定の唯一の情報源。docs/steps/pub-3.md 設計判断 7）", () => {
  it("findFirst の where は { id: userId } で呼ぶ（他人のIDを渡されない前提だが念のため絞る）", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue({ demoExpiresAt: new Date("2026-08-15T00:00:00.000Z") });

    await findDemoExpiresAt(client, "user_1" as UserId);

    expect(userFindFirst).toHaveBeenCalledWith({
      where: { id: "user_1" },
      select: { demoExpiresAt: true },
    });
  });

  it("デモユーザー（demoExpiresAt が Date）ならその値を返す", async () => {
    const { client, userFindFirst } = createMockClient();
    const expiresAt = new Date("2026-08-15T00:00:00.000Z");
    userFindFirst.mockResolvedValue({ demoExpiresAt: expiresAt });

    await expect(findDemoExpiresAt(client, "user_demo" as UserId)).resolves.toEqual(expiresAt);
  });

  it("通常のユーザー（demoExpiresAt が null）なら null", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue({ demoExpiresAt: null });

    await expect(findDemoExpiresAt(client, "user_normal" as UserId)).resolves.toBeNull();
  });

  it("行が無ければ（削除された後のセッションなど）null", async () => {
    const { client, userFindFirst } = createMockClient();
    userFindFirst.mockResolvedValue(null);

    await expect(findDemoExpiresAt(client, "user_ghost" as UserId)).resolves.toBeNull();
  });
});
