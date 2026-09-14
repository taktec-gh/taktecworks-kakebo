import type { MetadataRoute } from "next";

/**
 * 全クローラを拒否する。
 *
 * 個人用の家計簿で、検索結果に出て嬉しいことは何もない。
 * ログイン画面が索引されると総当たりの標的にもなる。
 * 併せて next.config.ts で全パスに X-Robots-Tag: noindex, nofollow を付けている
 * （robots.txt を読まないクローラ向け）。
 *
 * /robots.txt は認証不要（src/lib/auth.ts の isPublicPath）。
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
