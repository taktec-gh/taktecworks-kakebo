"use client";

import { useActionState } from "react";

import { initialLoginState, type LoginState } from "./login-state";

export type LoginFormAction = (
  prevState: LoginState,
  formData: FormData,
) => LoginState | Promise<LoginState>;

export type LoginFormProps = {
  /** ログイン処理。通常は Server Action の loginAction を渡す */
  action: LoginFormAction;
};

export function LoginForm({ action }: LoginFormProps) {
  const [state, formAction, pending] = useActionState(action, initialLoginState);

  return (
    <form action={formAction} className="flex w-full flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="text-sm font-medium">
          パスワード
        </label>
        {/* text-base(16px) 未満にすると iOS でフォーカス時に画面が拡大するため下げない */}
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          aria-describedby={state.error ? "login-error" : undefined}
          aria-invalid={state.error ? true : undefined}
          className="h-12 w-full rounded-lg border border-black/20 bg-white px-4 text-base text-black outline-none focus:border-black/60 dark:border-white/25 dark:bg-black dark:text-white dark:focus:border-white/70"
        />
      </div>

      {state.error ? (
        <p id="login-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="h-12 w-full rounded-lg bg-foreground text-base font-medium text-background disabled:opacity-60"
      >
        {pending ? "確認中…" : "ログイン"}
      </button>
    </form>
  );
}
