import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // スマホ実機からの動作確認のため、同一LAN内のPCのIPを dev リソース（HMR等）の
  // 許可オリジンに入れる。Next.js 16 は既定で localhost 以外からのアクセスを塞ぐ。
  // 開発時のみの設定で、本番ビルドには影響しない。
  allowedDevOrigins: ["192.168.10.113"],

  /**
   * 全パスに noindex を付ける。
   *
   * src/app/robots.ts で robots.txt でも拒否しているが、robots.txt を読まない
   * クローラや、他所から直接リンクされた場合に備えてヘッダでも指示する。
   * 個人用の家計簿なので検索結果に出る利点は何もない。
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
