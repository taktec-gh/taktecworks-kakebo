import { DEMO_LOGOUT_WARNING } from "@/lib/demo-messages";

/**
 * ダッシュボード上部のデモ表示（docs/steps/pub-3.md 設計判断 9）。
 *
 * 表示の判定（デモユーザーかどうか）は呼び出し側（src/app/page.tsx）が DB の demoExpiresAt で行う。
 * 通常のユーザーには出さない。
 */

export type DemoBannerProps = {
  /** 削除される日時（JST）の表示。formatDemoExpiresAtLabel(demoExpiresAt) */
  expiresAtLabel: string;
};

export function DemoBanner({ expiresAtLabel }: DemoBannerProps) {
  return (
    <section
      aria-label="デモアカウント"
      className="flex flex-col gap-1 rounded-lg border border-amber-500/60 px-4 py-3 text-sm"
    >
      <p className="font-semibold">これはデモアカウントです</p>
      <p>
        <span className="whitespace-nowrap">{expiresAtLabel}</span>
        （日本時間）に、このアカウントとデータは自動で削除されます。
      </p>
      <p className="opacity-80">{DEMO_LOGOUT_WARNING}</p>
    </section>
  );
}
