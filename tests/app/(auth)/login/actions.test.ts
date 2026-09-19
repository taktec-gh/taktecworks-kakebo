// @vitest-environment node
//
// src/app/(auth)/login/actions.ts の Server Action を検証する。
//
// 公開版ではパスワードログイン（loginAction）を廃止した
// （docs/steps/pub-1.md 設計判断 1「パスワードログインと RECOVERY_MODE はこの Step で
//   廃止する」「削除するもの: loginAction」）。このファイルの旧テストは loginAction の
// パスワード検証・レート制限を検証していたが、その対象が無くなったため、
// 残った logoutAction のテストに書き換えた
// （旧 tests/app/(auth)/login/actions.test.ts の19ケース、
//   tests/app/(auth)/login/actions-rate-limit.test.ts の19ケース、
//   tests/app/(auth)/login/login-form.test.tsx の13ケースは削除。詳細はレポート参照）。

// startDemoAction（デモで試す）のテストを追加した（公開版 Step 3。docs/steps/pub-3.md）。
// 絶対条件（design-decisions.md 決定事項2）: デモ用の入口はユーザーIDを外部から受け取らず、
// createDemoUser の戻り値（今作ったユーザー）にだけセッションを発行する。
// tests/app/(auth)/signup/actions.test.ts と同じ方針で、createDemoUser・isDemoRateLimited・
// createSession を高レベルにモックする（それぞれの内部の正しさは
// tests/lib/users.test.ts・tests/lib/demo-limits.test.ts・tests/lib/demo-data.test.ts で検証済み）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOGIN_PATH } from "@/lib/auth";
import { DEMO_ERRORS, DEMO_START_PATH } from "@/lib/demo-messages";

class RedirectError extends Error {
  digest: string;
  constructor(url: string) {
    super(`NEXT_REDIRECT;${url}`);
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

const redirect = vi.fn((url: string): never => {
  throw new RedirectError(url);
});
const destroySession = vi.fn(async () => {});
const createSession = vi.fn(async (..._args: unknown[]) => {});

vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("@/lib/session", () => ({
  destroySession: () => destroySession(),
  createSession: (...args: unknown[]) => createSession(...args),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

// ---- IP ハッシュのモック（next/headers に触れない。Cookie・クエリは読まない前提を検証する側で確認） ----
const getClientIpHash = vi.fn(async () => "iphash-test");
vi.mock("@/lib/client-ip", () => ({ getClientIpHash: () => getClientIpHash() }));

// ---- デモのレート制限のモック ----
const isDemoRateLimited = vi.fn(async (..._args: unknown[]) => false);
vi.mock("@/lib/demo-limits", () => ({
  isDemoRateLimited: (...args: unknown[]) => isDemoRateLimited(...args),
}));

// ---- デモユーザー作成のモック ----
const createDemoUser = vi.fn();
vi.mock("@/lib/users", () => ({
  createDemoUser: (...args: unknown[]) => createDemoUser(...args),
}));

const { logoutAction, startDemoAction } = await import("@/app/(auth)/login/actions");

const DEMO_USER_ID = "user_demo_brand_new";
const DEMO_EXPIRES_AT = new Date("2026-08-15T00:00:00.000Z");

beforeEach(() => {
  redirect.mockClear();
  destroySession.mockClear();
  createSession.mockClear();
  getClientIpHash.mockClear();
  getClientIpHash.mockResolvedValue("iphash-test");
  isDemoRateLimited.mockReset();
  isDemoRateLimited.mockResolvedValue(false);
  createDemoUser.mockReset();
  createDemoUser.mockResolvedValue({ userId: DEMO_USER_ID, demoExpiresAt: DEMO_EXPIRES_AT });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("logoutAction", () => {
  it("セッションを破棄して /login へリダイレクトする", async () => {
    await expect(logoutAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(destroySession).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith(LOGIN_PATH);
  });

  it("破棄してからリダイレクトする（順序が逆だと Cookie が消える前に画面遷移してしまう）", async () => {
    await logoutAction().catch(() => {});
    expect(destroySession.mock.invocationCallOrder[0]).toBeLessThan(
      redirect.mock.invocationCallOrder[0],
    );
  });
});

describe("startDemoAction — 絶対条件（design-decisions.md 決定事項2・docs/steps/pub-3.md 設計判断3）", () => {
  it("引数を受け取らない（シグネチャに引数が無い。呼び出しても TypeScript の型上、渡すものが無い）", () => {
    // useActionState はフォームの FormData を第2引数として渡すが、startDemoAction は
    // それを宣言していないため JS 的にも読めない。関数の length（宣言された仮引数の数）で確認する
    expect(startDemoAction.length).toBe(0);
  });

  it("FormData を伴って呼ばれても（useActionState 経由を模して）無視され、createDemoUser の戻り値のユーザーにだけセッションを発行する", async () => {
    // startDemoAction は引数を宣言していないため、余分な引数を渡しても JS 的に無視される。
    // ここでは「渡しても」効果が無いことを直接確認する。
    const formData = new FormData();
    formData.set("userId", "user_attacker_supplied");
    formData.set("id", "user_attacker_supplied");

    await expect(
      (startDemoAction as unknown as (a: unknown, b: unknown) => Promise<unknown>)(
        { error: null },
        formData,
      ),
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(createDemoUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ipHash: "iphash-test" }),
    );
    // createDemoUser に渡す入力に、外部由来の値（フォームの userId）が含まれない
    const input = createDemoUser.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["ipHash", "now"]);
    expect(JSON.stringify(input)).not.toContain("user_attacker_supplied");

    expect(createSession).toHaveBeenCalledWith(
      DEMO_USER_ID,
      expect.objectContaining({}),
    );
    expect(createSession).not.toHaveBeenCalledWith(
      "user_attacker_supplied",
      expect.anything(),
    );
  });

  it("セッションは createDemoUser の戻り値の userId にだけ発行される", async () => {
    createDemoUser.mockResolvedValue({ userId: "user_specific", demoExpiresAt: DEMO_EXPIRES_AT });

    await expect(startDemoAction()).rejects.toThrow("NEXT_REDIRECT");

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0][0]).toBe("user_specific");
  });

  it("成功したら DEMO_START_PATH（ダッシュボード）へ redirect する", async () => {
    await expect(startDemoAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith(DEMO_START_PATH);
    expect(DEMO_START_PATH).toBe("/");
  });
});

describe("startDemoAction — デモのセッションの期限（設計判断2・4）", () => {
  it("createSession の maxAgeSeconds は、createDemoUser が返した demoExpiresAt から計算した秒数", async () => {
    const now = new Date("2026-08-14T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    createDemoUser.mockResolvedValue({
      userId: DEMO_USER_ID,
      // 24時間後（DEMO_TTL_HOURS）
      demoExpiresAt: new Date("2026-08-15T00:00:00.000Z"),
    });

    try {
      await expect(startDemoAction()).rejects.toThrow("NEXT_REDIRECT");
    } finally {
      vi.useRealTimers();
    }

    // 手計算: 24h = 86,400秒
    expect(createSession).toHaveBeenCalledWith(
      DEMO_USER_ID,
      expect.objectContaining({ maxAgeSeconds: 86_400 }),
    );
  });

  it("now は createDemoUser に渡した now と同じ値を createSession にも渡す（iat の基準を揃える）", async () => {
    const now = new Date("2026-08-14T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      await expect(startDemoAction()).rejects.toThrow("NEXT_REDIRECT");
    } finally {
      vi.useRealTimers();
    }

    const demoUserNow = (createDemoUser.mock.calls[0][1] as { now: Date }).now;
    const sessionNow = (createSession.mock.calls[0][1] as { now: Date }).now;
    expect(sessionNow.getTime()).toBe(demoUserNow.getTime());
  });
});

describe("startDemoAction — レート制限（設計判断4）", () => {
  it("制限中は rateLimited を返し、createDemoUser・createSession を呼ばない（redirect しない）", async () => {
    isDemoRateLimited.mockResolvedValue(true);

    const result = await startDemoAction();

    expect(result).toEqual({ error: DEMO_ERRORS.rateLimited });
    expect(createDemoUser).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("isDemoRateLimited には getClientIpHash() の戻り値を渡す", async () => {
    getClientIpHash.mockResolvedValue("iphash-specific");
    isDemoRateLimited.mockResolvedValue(true);

    await startDemoAction();

    expect(isDemoRateLimited).toHaveBeenCalledWith(expect.anything(), "iphash-specific", expect.any(Date));
  });
});

describe("startDemoAction — 失敗時は内部事情を出さない（fail closed）", () => {
  it("IP ハッシュの取得に失敗しても unavailable", async () => {
    getClientIpHash.mockRejectedValue(new Error("AUTH_SECRET is not set"));

    const result = await startDemoAction();

    expect(result).toEqual({ error: DEMO_ERRORS.unavailable });
    expect(createDemoUser).not.toHaveBeenCalled();
  });

  it("createDemoUser が例外を投げたら unavailable。createSession は呼ばれない", async () => {
    createDemoUser.mockRejectedValue(new Error("db unavailable"));

    const result = await startDemoAction();

    expect(result).toEqual({ error: DEMO_ERRORS.unavailable });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("ユーザー作成後にセッション発行が失敗しても unavailable を返す（内部のエラー内容は出さない）", async () => {
    createSession.mockRejectedValueOnce(new Error("cookie store failure"));

    const result = await startDemoAction();

    expect(result).toEqual({ error: DEMO_ERRORS.unavailable });
    expect(createDemoUser).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("失敗の文言に内部事情（DB・IP・AUTH_SECRET 等の語）が出ない", () => {
    for (const leak of ["AUTH_SECRET", "DATABASE", "prisma", "Error"]) {
      expect(DEMO_ERRORS.unavailable).not.toContain(leak);
      expect(DEMO_ERRORS.rateLimited).not.toContain(leak);
    }
  });
});

describe("startDemoAction — 既存のセッションがあっても拒否しない", () => {
  it("（前提の確認）startDemoAction は getSession/requireUserId を呼ばない。ログイン前でも実行できる", async () => {
    // このファイルは @/lib/session を destroySession/createSession だけにモックしており、
    // requireUserId/getSession は提供していない。もし startDemoAction がそれらを呼べば
    // モジュール解決の時点で読み込みに失敗するはずだが、正常に import・実行できていることが
    // 「ログイン前提のチェックをしていない」ことの根拠になる。
    await expect(startDemoAction()).rejects.toThrow("NEXT_REDIRECT");
  });
});
