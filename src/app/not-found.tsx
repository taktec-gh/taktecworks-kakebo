import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "ページが見つかりません | 家計簿",
};

/**
 * 404 画面。
 *
 * Next.js の既定の 404 画面はインラインの `style` 属性と nonce の無い `<style>` を使うため、
 * nonce 方式の CSP（style-src に 'unsafe-inline' が無い）では CSP 違反になり、見た目も崩れる。
 * Tailwind のクラスだけで描く自前の画面に置き換える（docs/steps/pub-4.md 設計判断 3 と同じ理由）。
 *
 * ログイン中かどうかに関わらず出るので、戻り先はトップ（未ログインなら proxy がログインへ送る）。
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center px-5 py-10">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-bold">ページが見つかりません</h1>
        <p className="text-sm opacity-70">URL が間違っているか、ページが削除された可能性があります。</p>
        <Link href="/" className="font-semibold underline underline-offset-4">
          トップへ戻る
        </Link>
      </div>
    </main>
  );
}
