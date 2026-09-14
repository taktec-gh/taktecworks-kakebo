// @vitest-environment node
//
// Step 1 の完了条件「スマホからログインできる」に関わる部分だけを検証する。
// レイアウトの描画そのものは <html>/<body> を含むため単体描画に向かないので、
// メタデータの export のみを対象にする。

import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans", className: "font-geist-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono", className: "font-geist-mono" }),
}));

const { metadata, viewport } = await import("@/app/layout");

describe("ルートレイアウトの viewport", () => {
  it("端末幅に合わせる（スマホで横スクロールしない）", () => {
    expect(viewport).toMatchObject({ width: "device-width", initialScale: 1 });
  });

  it("ピンチズームを禁止しない（拡大できないと使えない人が出る）", () => {
    const v = viewport as { maximumScale?: number; userScalable?: boolean };
    expect(v.userScalable).not.toBe(false);
    if (v.maximumScale !== undefined) {
      expect(v.maximumScale).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("ルートレイアウトの metadata", () => {
  it("タイトルが設定されている（ホーム画面に追加したときの表示名になる）", () => {
    expect(metadata.title).toBeTruthy();
  });
});
