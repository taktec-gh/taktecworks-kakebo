// next.config.ts を検証する。
//
// 期待値の根拠:
// - docs/steps/step-7.md「実装するファイル」next.config.ts の役割
//   「X-Robots-Tag: noindex, nofollow を全パスに付ける」
// - next.config.ts 内のコメント（robots.txt を読まないクローラ対策）
// - docs/steps/pub-4.md 設計判断 4（その他のセキュリティヘッダーの表）と
//   tester 向けの方針 5（X-Robots-Tag が残る・Referrer-Policy が no-referrer でない・
//   Permissions-Policy がパスキーを塞いでいない・poweredByHeader が false）

import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

type HeaderEntry = { key: string; value: string };

async function getHeaderEntries(): Promise<HeaderEntry[]> {
  expect(typeof nextConfig.headers).toBe("function");
  const headerRules = await nextConfig.headers!();
  expect(headerRules).toHaveLength(1);
  expect(headerRules[0].source).toBe("/:path*");
  return headerRules[0].headers as HeaderEntry[];
}

function valueOf(entries: HeaderEntry[], key: string): string {
  const entry = entries.find((h) => h.key === key);
  expect(entry, `ヘッダー ${key} が見つかりません`).toBeDefined();
  return entry!.value;
}

describe("next.config headers()", () => {
  it("全パス（'/:path*'）に X-Robots-Tag: noindex, nofollow を付ける", async () => {
    const entries = await getHeaderEntries();
    expect(valueOf(entries, "X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("HSTS: max-age 2年・includeSubDomains（preloadは付けない）", async () => {
    const entries = await getHeaderEntries();
    const value = valueOf(entries, "Strict-Transport-Security");
    expect(value).toBe("max-age=63072000; includeSubDomains");
    expect(value).not.toContain("preload");
  });

  it("X-Content-Type-Options: nosniff", async () => {
    const entries = await getHeaderEntries();
    expect(valueOf(entries, "X-Content-Type-Options")).toBe("nosniff");
  });

  it("X-Frame-Options: DENY（クリックジャッキング対策）", async () => {
    const entries = await getHeaderEntries();
    expect(valueOf(entries, "X-Frame-Options")).toBe("DENY");
  });

  it("Referrer-Policy: strict-origin-when-cross-origin（no-referrer にしない）", async () => {
    const entries = await getHeaderEntries();
    const value = valueOf(entries, "Referrer-Policy");
    expect(value).toBe("strict-origin-when-cross-origin");
    expect(value).not.toBe("no-referrer");
  });

  it("Permissions-Policy: camera/microphone/geolocation/payment/usb を無効化し、パスキーは塞がない", async () => {
    const entries = await getHeaderEntries();
    const value = valueOf(entries, "Permissions-Policy");
    expect(value).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    expect(value).not.toContain("publickey-credentials-get");
    expect(value).not.toContain("publickey-credentials-create");
  });

  it("Cross-Origin-Opener-Policy: same-origin", async () => {
    const entries = await getHeaderEntries();
    expect(valueOf(entries, "Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("Content-Security-Policy はここに置かない（nonce がリクエストごとに違うため proxy の担当）", async () => {
    const entries = await getHeaderEntries();
    expect(entries.some((h) => h.key === "Content-Security-Policy")).toBe(false);
  });

  it("設計判断4の表にあるヘッダーだけを持つ（余計な増減が無い）", async () => {
    const entries = await getHeaderEntries();
    expect(entries.map((h) => h.key).sort()).toEqual(
      [
        "X-Robots-Tag",
        "Strict-Transport-Security",
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "Permissions-Policy",
        "Cross-Origin-Opener-Policy",
      ].sort(),
    );
  });
});

describe("next.config poweredByHeader", () => {
  it("X-Powered-By: Next.js を出さない", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
