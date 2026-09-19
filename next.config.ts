import type { NextConfig } from "next";

/**
 * 環境変数 DEV_ALLOWED_ORIGINS（カンマ区切り）を allowedDevOrigins の配列にする。
 * 未設定・空なら空配列（localhost 以外からの dev リソースへのアクセスを許さない）。
 *
 * 手元の LAN の IP をリポジトリに直書きしないため、値は .env（コミットしない）に置く。
 */
export function parseAllowedDevOrigins(value: string | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

const nextConfig: NextConfig = {
  // スマホ実機からの動作確認のため、同一LAN内のPCのIPを dev リソース（HMR等）の
  // 許可オリジンに入れる。Next.js 16 は既定で localhost 以外からのアクセスを塞ぐ。
  // 開発時のみの設定で、本番ビルドには影響しない。
  // なお、http の LAN の IP ではパスキーは動かない（https か localhost のみ）。見た目の確認用
  allowedDevOrigins: parseAllowedDevOrigins(process.env.DEV_ALLOWED_ORIGINS),

  // X-Powered-By: Next.js を出さない（使っている技術と版を外に知らせない）
  poweredByHeader: false,

  /**
   * 全パス（静的ファイルを含む）に付けるヘッダー。
   *
   * X-Robots-Tag: src/app/robots.ts で robots.txt でも拒否しているが、robots.txt を読まない
   * クローラや、他所から直接リンクされた場合に備えてヘッダでも指示する。
   * 個人用の家計簿なので検索結果に出る利点は何もない。
   *
   * それ以外はセキュリティヘッダー（docs/steps/pub-4.md 設計判断 4）。
   * - Referrer-Policy を no-referrer にしない（同一オリジンの POST で Origin が null になりうり、
   *   Server Actions の Origin チェックで全フォームが失敗するおそれがある）
   * - Permissions-Policy で publickey-credentials-get / -create を塞がない（パスキーが動かなくなる）
   * - CSP は nonce がリクエストごとに違うのでここには置かない（src/proxy.ts の担当）
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
