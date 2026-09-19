"use client";

import { useActionState } from "react";

import {
  DEMO_LOGIN_NOTICES,
  DEMO_START_LABEL,
  INITIAL_DEMO_ACTION_STATE,
  type DemoActionState,
} from "@/lib/demo-messages";

/**
 * 「デモで試す（登録不要）」のボタンと注意書き（docs/steps/pub-3.md 設計判断 9）。
 *
 * Server Action は props で受け取る（他の画面と同じ形。テストから差し替えられる）。
 * 成功時は Server Action が redirect するので、ここでは失敗の文言だけを出す。
 * ボタンのほかに入力欄を持たない（デモの入口は何も受け取らない。設計判断 3）。
 */

export type DemoStartButtonProps = {
  /** 通常は startDemoAction。引数を読まない */
  start: () => Promise<DemoActionState>;
};

export function DemoStartButton({ start }: DemoStartButtonProps) {
  const [state, formAction, pending] = useActionState(start, INITIAL_DEMO_ACTION_STATE);

  return (
    <form action={formAction} className="flex w-full flex-col gap-3">
      <button
        type="submit"
        disabled={pending}
        className="h-14 w-full rounded-lg bg-foreground text-lg font-bold text-background disabled:opacity-60"
      >
        {pending ? "デモを準備中…" : DEMO_START_LABEL}
      </button>

      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm opacity-80">
        {DEMO_LOGIN_NOTICES.map((notice) => (
          <li key={notice}>{notice}</li>
        ))}
      </ul>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
