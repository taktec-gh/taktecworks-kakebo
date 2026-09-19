// @vitest-environment node
//
// src/app/api/cron/cleanup/route.ts（GET。期限切れのデモユーザーと古い記録を消す定期処理）を検証する。
//
// docs/steps/pub-3.md「tester 向けの方針」2「Cron の認証」の中心となるテスト。
// 純粋関数のレベル（tests/lib/cron-auth.test.ts）とは別に、実際の Route Handler が
// ヘッダを正しく読み、認証結果に応じて 401 / 200 / 500 を返すことを確認する。
//
// 期待値の根拠:
// - docs/steps/pub-3.md 設計判断 5
//   「認証に失敗したら 401。本文に理由を書かない」
//   「応答は件数だけを JSON で返す。ユーザーIDやデータの中身を返さない・ログに出さない」
// - docs/steps/pub-3.md「実装完了後の引き継ぎ」
//   「GET。認証失敗は 401・空本文、成功は 200 と件数4つの JSON、例外は 500・空本文」

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCleanup = vi.fn();
vi.mock("@/lib/cleanup", () => ({
  runCleanup: (...args: unknown[]) => runCleanup(...args),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { GET } = await import("@/app/api/cron/cleanup/route");

const SECRET = "test-cron-secret-0123456789abcdef";

function requestWith(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request("http://localhost/api/cron/cleanup", { headers });
}

beforeEach(() => {
  runCleanup.mockReset();
  runCleanup.mockResolvedValue({
    deletedDemoUsers: 3,
    deletedSignupEvents: 1,
    deletedDemoEvents: 2,
    deletedLoginAttempts: 4,
  });
  vi.stubEnv("CRON_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("認証失敗（401）", () => {
  it("Authorization ヘッダが無ければ 401。runCleanup は呼ばない", async () => {
    const response = await GET(requestWith());
    expect(response.status).toBe(401);
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it("違う値の Bearer なら 401", async () => {
    const response = await GET(requestWith("Bearer wrong-secret"));
    expect(response.status).toBe(401);
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it("本文に理由を書かない（空本文）", async () => {
    const response = await GET(requestWith());
    const text = await response.text();
    expect(text).toBe("");
  });

  it("CRON_SECRET が未設定なら、正しく見える Bearer でも 401（fail closed）", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await GET(requestWith(`Bearer ${SECRET}`));
    expect(response.status).toBe(401);
    expect(runCleanup).not.toHaveBeenCalled();
  });

  it("CRON_SECRET が空文字なら、空の Bearer ヘッダでも 401", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await GET(requestWith("Bearer "));
    expect(response.status).toBe(401);
    expect(runCleanup).not.toHaveBeenCalled();
  });
});

describe("認証成功（200）", () => {
  it("正しい Bearer なら 200 を返し runCleanup を1回呼ぶ", async () => {
    const response = await GET(requestWith(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(runCleanup).toHaveBeenCalledTimes(1);
  });

  it("応答の JSON は runCleanup の戻り値の件数のみ", async () => {
    const response = await GET(requestWith(`Bearer ${SECRET}`));
    const body = await response.json();
    expect(body).toEqual({
      deletedDemoUsers: 3,
      deletedSignupEvents: 1,
      deletedDemoEvents: 2,
      deletedLoginAttempts: 4,
    });
  });

  it("応答にユーザーIDやデータの中身を含まない", async () => {
    runCleanup.mockResolvedValue({
      deletedDemoUsers: 1,
      deletedSignupEvents: 0,
      deletedDemoEvents: 0,
      deletedLoginAttempts: 0,
    });
    const response = await GET(requestWith(`Bearer ${SECRET}`));
    const text = await response.text();
    expect(text).not.toContain("user_");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "deletedDemoEvents",
      "deletedDemoUsers",
      "deletedLoginAttempts",
      "deletedSignupEvents",
    ]);
  });

  it("runCleanup には prisma クライアントと Date を渡す", async () => {
    await GET(requestWith(`Bearer ${SECRET}`));
    expect(runCleanup).toHaveBeenCalledWith(expect.anything(), expect.any(Date));
  });
});

describe("例外（500）", () => {
  it("runCleanup が例外を投げたら 500・空本文（内部事情を出さない）", async () => {
    runCleanup.mockRejectedValue(new Error("DATABASE_URL=postgres://user:secret@host/db unreachable"));
    const response = await GET(requestWith(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe("");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("DATABASE_URL");
  });
});
