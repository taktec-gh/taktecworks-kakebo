import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "家計簿",
  description: "個人用家計簿アプリ",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * connection() で全ページを動的レンダリングにする。
 *
 * CSP の nonce は描画のたびに Next.js がスクリプトに付けるため、静的に生成されたページには
 * nonce が入らず、本番でスクリプトが全部ブロックされる（docs/steps/pub-4.md 設計判断 5）。
 * ルートレイアウトで一度だけ行い、ページを足したときに付け忘れないようにする。
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();

  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
