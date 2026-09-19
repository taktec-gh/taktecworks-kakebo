// src/lib/csp.ts の nonce 生成と CSP 組み立てを検証する。
//
// 期待値の根拠:
// - docs/steps/pub-4.md 設計判断 1・2（本番のポリシー全文、開発だけ緩める判定は
//   `NODE_ENV === "development"` の一致で行う）
// - docs/steps/pub-4.md「実装完了後の引き継ぎ」のポリシー全文（開発の style-src は
//   nonce を外して 'unsafe-inline' にする）
// - node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md
//   「Development vs Production Considerations > Development Environment」に同じ形の例がある
//   （nonce があるとブラウザは 'unsafe-inline' を無視するため、開発時は style-src から nonce を外す）
// - docs/steps/pub-4.md tester 向けの方針 1〜3

import { describe, expect, it } from "vitest";

import {
  buildContentSecurityPolicy,
  CSP_HEADER_NAME,
  generateNonce,
  isDevelopmentEnv,
  isValidNonce,
  NONCE_BYTES,
  NONCE_HEADER_NAME,
} from "@/lib/csp";

describe("ヘッダ名の定数", () => {
  it("CSP のヘッダ名は Content-Security-Policy", () => {
    expect(CSP_HEADER_NAME).toBe("Content-Security-Policy");
  });

  it("nonce を渡すリクエストヘッダ名は x-nonce（公式の手順に合わせる）", () => {
    expect(NONCE_HEADER_NAME).toBe("x-nonce");
  });

  it("nonce は128ビット（16バイト）以上", () => {
    expect(NONCE_BYTES).toBeGreaterThanOrEqual(16);
  });
});

// 文字数の境界がテストの正しさに直結するため、'A' の連続は毎回 "A".repeat(n) で
// 正確な文字数を作る（手で数えたリテラルは1文字ずれるおそれがある）。
const A22 = "A".repeat(22);

describe("isValidNonce", () => {
  it.each([
    ["22文字ちょうど・パディング無し", A22],
    ["24文字・パディング2文字", `${A22}==`],
    ["23文字・パディング1文字", `${A22}=`],
    ["+ と / を含む", `${A22.slice(0, 20)}+/`],
    ["22文字より長い", A22 + A22],
  ])("%s は有効", (_label, nonce) => {
    expect(isValidNonce(nonce)).toBe(true);
  });

  it.each([
    ["空文字", ""],
    ["21文字（1文字足りない）", A22.slice(0, 21)],
    ["シングルクォートを含む（22文字は保つ）", `${A22.slice(0, 21)}'`],
    ["セミコロンを含む（22文字は保つ）", `${A22.slice(0, 21)};`],
    ["空白を含む（22文字は保つ）", `${A22.slice(0, 21)} `],
    ["改行を含む（22文字は保つ）", `${A22.slice(0, 21)}\n`],
    ["タブを含む（22文字は保つ）", `${A22.slice(0, 21)}\t`],
    ["=が途中にある", `${A22.slice(0, 10)}=${A22.slice(10)}`],
    ["パディングが3文字", `${A22}===`],
    ["base64に無い記号(<script>)", `<script>alert(1)</script>${A22}`],
  ])("%s は無効", (_label, nonce) => {
    expect(isValidNonce(nonce)).toBe(false);
  });
});

describe("generateNonce", () => {
  it("isValidNonce を満たす値を作る", () => {
    expect(isValidNonce(generateNonce())).toBe(true);
  });

  it("呼ぶたびに異なる値を作る（予測できないことが nonce の防御のすべて）", () => {
    const values = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(values.size).toBe(50);
  });

  it("16バイトの乱数を base64 にした24文字", () => {
    expect(generateNonce()).toHaveLength(24);
  });
});

describe("isDevelopmentEnv", () => {
  it("'development' のときだけ true", () => {
    expect(isDevelopmentEnv("development")).toBe(true);
  });

  it.each([
    ["production", "production"],
    ["test", "test"],
    ["未設定", undefined],
    ["空文字", ""],
    ["先頭が大文字(Development)", "Development"],
    ["全部大文字(DEVELOPMENT)", "DEVELOPMENT"],
    ["前後に空白", " development "],
    ["接頭辞が同じ別の値", "development-local"],
  ])("%s では false（「production でなければ緩める」にしない）", (_label, value) => {
    expect(isDevelopmentEnv(value)).toBe(false);
  });
});

/** ポリシー文字列から指定ディレクティブの値部分だけを取り出す */
function extractDirective(csp: string, name: string): string {
  const directive = csp.split("; ").find((d) => d.startsWith(`${name} `) || d === name);
  if (directive === undefined) {
    throw new Error(`ディレクティブ ${name} が見つかりません: ${csp}`);
  }
  return directive;
}

const NONCE = "AAECAwQFBgcICQoLDA0ODw=="; // generateNonce() が返す形の値（テスト用に固定）

describe("buildContentSecurityPolicy", () => {
  it("不正な形の nonce は例外を投げる", () => {
    expect(() =>
      buildContentSecurityPolicy({ nonce: "not a nonce; injected", isDev: false }),
    ).toThrow();
    expect(() => buildContentSecurityPolicy({ nonce: "", isDev: false })).toThrow();
  });

  describe("本番（isDev: false）", () => {
    // docs/steps/pub-4.md 設計判断 2 のポリシー全文をそのまま手で組み立てた期待値。
    const expected = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`,
      `style-src 'self' 'nonce-${NONCE}'`,
      "img-src 'self' blob: data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");

    it("ポリシー全文が仕様どおり（区切りは'; '、末尾に';'無し）", () => {
      const csp = buildContentSecurityPolicy({ nonce: NONCE, isDev: false });
      expect(csp).toBe(expected);
      expect(csp.endsWith(";")).toBe(false);
    });

    it("'unsafe-inline' も 'unsafe-eval' も script-src・style-src に無い", () => {
      const csp = buildContentSecurityPolicy({ nonce: NONCE, isDev: false });
      expect(extractDirective(csp, "script-src")).not.toContain("unsafe-inline");
      expect(extractDirective(csp, "script-src")).not.toContain("unsafe-eval");
      expect(extractDirective(csp, "style-src")).not.toContain("unsafe-inline");
      expect(extractDirective(csp, "style-src")).not.toContain("unsafe-eval");
    });

    it("外部ドメイン・ワイルドカード・スキーム全体の許可が script-src に無い", () => {
      const csp = buildContentSecurityPolicy({ nonce: NONCE, isDev: false });
      const scriptSrc = extractDirective(csp, "script-src");
      expect(scriptSrc).not.toMatch(/\*/);
      expect(scriptSrc).not.toMatch(/https:|http:/);
      expect(scriptSrc).not.toContain("data:");
    });

    it("script-src に nonce と 'strict-dynamic' がある", () => {
      const csp = buildContentSecurityPolicy({ nonce: NONCE, isDev: false });
      const scriptSrc = extractDirective(csp, "script-src");
      expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
      expect(scriptSrc).toContain("'strict-dynamic'");
    });

    it("object-src 'none' / base-uri 'self' / form-action 'self' / frame-ancestors 'none' がある", () => {
      const csp = buildContentSecurityPolicy({ nonce: NONCE, isDev: false });
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("upgrade-insecure-requests が無い（ローカルの http での next start が壊れうるため入れない）", () => {
      const csp = buildContentSecurityPolicy({ nonce: NONCE, isDev: false });
      expect(csp).not.toContain("upgrade-insecure-requests");
    });
  });

  describe("開発（isDev: true）", () => {
    // 公式ドキュメントの「Development Environment」節と同じ形。
    // nonce があるとブラウザは 'unsafe-inline' を無視するため、style-src は nonce を外す。
    const expected = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' 'unsafe-eval'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");

    it("ポリシー全文（script-src に'unsafe-eval'、style-srcは nonce無しの'unsafe-inline'）", () => {
      const csp = buildContentSecurityPolicy({ nonce: NONCE, isDev: true });
      expect(csp).toBe(expected);
    });

    it("upgrade-insecure-requests は開発でも入れない", () => {
      const csp = buildContentSecurityPolicy({ nonce: NONCE, isDev: true });
      expect(csp).not.toContain("upgrade-insecure-requests");
    });

    it("外部ドメインは開発でも許可しない", () => {
      const csp = buildContentSecurityPolicy({ nonce: NONCE, isDev: true });
      expect(csp).not.toMatch(/https:\/\/|http:\/\//);
    });
  });
});
