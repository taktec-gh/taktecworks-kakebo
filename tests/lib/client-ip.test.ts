// @vitest-environment node
// jose の hashIp (crypto) は Node で問題ないが、他の Step7 ファイルと環境を揃える。
//
// src/lib/client-ip.ts（next/headers との接続）を検証する。
//
// 期待値の根拠:
// - docs/steps/step-7.md「特に壊れやすい箇所 > IP の扱い」
//   「生IPが LoginAttempt.ipHash に入っていない。x-forwarded-for が複数値なら先頭を使う。
//    無ければ 'unknown'」

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashIp } from "@/lib/login-attempts";

const SECRET = "test-auth-secret-0123456789abcdef";

let forwardedFor: string | null = null;

vi.mock("next/headers", () => ({
  headers: async () => new Headers(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
}));

const { getClientIp, getClientIpHash } = await import("@/lib/client-ip");

beforeEach(() => {
  forwardedFor = null;
  vi.stubEnv("AUTH_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getClientIp", () => {
  it("x-forwarded-for をそのまま返す（単一値）", async () => {
    forwardedFor = "203.0.113.9";
    await expect(getClientIp()).resolves.toBe("203.0.113.9");
  });

  it("複数値のときは先頭を返す", async () => {
    forwardedFor = "203.0.113.9, 70.41.3.18";
    await expect(getClientIp()).resolves.toBe("203.0.113.9");
  });

  it("ヘッダが無ければ 'unknown'", async () => {
    forwardedFor = null;
    await expect(getClientIp()).resolves.toBe("unknown");
  });
});

describe("getClientIpHash", () => {
  it("生IPを返さず、ハッシュ化した値を返す", async () => {
    forwardedFor = "203.0.113.9";
    const hash = await getClientIpHash();
    expect(hash).not.toContain("203.0.113.9");
    expect(hash).toBe(hashIp("203.0.113.9", SECRET));
  });

  it("AUTH_SECRET が違えばハッシュも変わる", async () => {
    forwardedFor = "203.0.113.9";
    const hash = await getClientIpHash();
    expect(hash).not.toBe(hashIp("203.0.113.9", "different-secret"));
  });

  it("AUTH_SECRET 未設定なら throw する（fail closed）", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    forwardedFor = "203.0.113.9";
    await expect(getClientIpHash()).rejects.toThrow("AUTH_SECRET is not set");
  });

  it("IP が取得できない場合も 'unknown' をハッシュ化して返す（throw しない）", async () => {
    forwardedFor = null;
    const hash = await getClientIpHash();
    expect(hash).toBe(hashIp("unknown", SECRET));
  });
});
