"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/**
 * 新しいリカバリーコードを一度だけ表示する部品（docs/steps/pub-5.md 設計判断 3・4・8）。
 * サインアップの完了・リカバリーの完了・設定画面での作り直しで使う。
 *
 * - コードは等幅で読みやすく出す。**コピーのボタン**を置く（navigator.clipboard.writeText。
 *   使えない環境ではボタンを出さない。失敗したら書き写すよう伝える）
 * - 「この画面を閉じると二度と表示されない」「パスキーを全部なくしたときに使う」
 *   「なくした場合は設定から作り直せる」ことを書く
 * - **「控えました」にチェックするまで先へ進むボタンを押せない**
 * - コードをどこにも保存しない（state に持つのは呼び出し側。ここは受け取って出すだけ）
 * - インラインの style を使わない（Step 4 の CSP）
 */

export const RECOVERY_CODE_HEADING = "リカバリーコード";

export const RECOVERY_CODE_NOTICES = [
  "パスキーを登録した端末をすべてなくしたときに、このコードでアカウントに戻れます。",
  "この画面を閉じると、このコードは二度と表示されません。紙に書き写すか、パスワード管理アプリなどに保存してください。",
  "コードは一度使うと使えなくなり、そのときに新しいコードが表示されます。",
  "コードをなくした場合は、ログインして「設定 > パスキー」から作り直せます。",
] as const;

export const RECOVERY_CODE_CONFIRM_LABEL = "リカバリーコードを控えました";
export const RECOVERY_CODE_COPY_LABEL = "コピー";
export const RECOVERY_CODE_COPIED_MESSAGE = "コピーしました。";
export const RECOVERY_CODE_COPY_FAILED_MESSAGE =
  "コピーできませんでした。画面のコードを書き写してください。";

export type RecoveryCodeDisplayProps = {
  /** 表示用に区切った平文のコード（Server Action の戻り値） */
  code: string;
  /** 見出しの前に出す一文（「アカウントを作りました。」など） */
  lead?: ReactNode;
  /** 注意書きに足す案内（リカバリー完了時の「なくした端末のパスキーは削除してください」など） */
  notice?: ReactNode;
  /** 「控えました」の後に押すボタンの文言 */
  continueLabel: string;
  /** 「控えました」の後にボタンを押したとき */
  onContinue: () => void;
  /** クリップボードへの書き込み。既定は navigator.clipboard.writeText */
  copy?: (text: string) => Promise<void>;
  /** コピーできる環境か。既定は navigator.clipboard.writeText の有無 */
  canCopy?: () => boolean;
};

function defaultCopy(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

function defaultCanCopy(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard !== "undefined" &&
    typeof navigator.clipboard.writeText === "function"
  );
}

/** 購読するものが無いので、解除だけを返す空の subscribe */
function subscribeNothing(): () => void {
  return () => {};
}

/** サーバ描画時はコピーできないとみなす（押しても動かないボタンを出さない） */
function assumeNoClipboard(): boolean {
  return false;
}

export function RecoveryCodeDisplay({
  code,
  lead,
  notice,
  continueLabel,
  onContinue,
  copy = defaultCopy,
  canCopy = defaultCanCopy,
}: RecoveryCodeDisplayProps) {
  const [confirmed, setConfirmed] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copyAvailable = useSyncExternalStore(subscribeNothing, canCopy, assumeNoClipboard);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const confirmId = useId();

  // 表示に切り替わったら見出しへ移る（スマホで入力欄の位置のまま、コードが画面の外に出ないように）
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  async function handleCopy(): Promise<void> {
    try {
      await copy(code);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return (
    <section aria-labelledby={`${confirmId}-heading`} className="flex w-full flex-col gap-4">
      {lead ? <p className="text-sm font-semibold">{lead}</p> : null}

      <h2
        id={`${confirmId}-heading`}
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-bold outline-none"
      >
        {RECOVERY_CODE_HEADING}
      </h2>

      <div className="flex flex-col gap-2 rounded-lg border border-black/20 px-4 py-4 dark:border-white/25">
        {/* 読み上げで1文字ずつ区切って読めるよう、見た目どおりの文字列をそのまま出す */}
        <p
          data-testid="recovery-code"
          className="break-all text-center font-mono text-xl font-bold tracking-wider sm:text-2xl"
        >
          {code}
        </p>
        {copyAvailable ? (
          <button
            type="button"
            onClick={handleCopy}
            className="h-11 w-full rounded-lg border border-black/20 text-base font-semibold dark:border-white/25"
          >
            {RECOVERY_CODE_COPY_LABEL}
          </button>
        ) : null}
        {copyStatus === "copied" ? (
          <p role="status" className="text-sm text-green-700 dark:text-green-400">
            {RECOVERY_CODE_COPIED_MESSAGE}
          </p>
        ) : null}
        {copyStatus === "failed" ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {RECOVERY_CODE_COPY_FAILED_MESSAGE}
          </p>
        ) : null}
      </div>

      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed">
        {RECOVERY_CODE_NOTICES.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>

      {notice ? (
        <p className="rounded-lg border border-amber-500/60 px-4 py-3 text-sm">{notice}</p>
      ) : null}

      <label htmlFor={confirmId} className="flex items-center gap-3 text-base">
        <input
          id={confirmId}
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="size-5"
        />
        {RECOVERY_CODE_CONFIRM_LABEL}
      </label>

      <button
        type="button"
        onClick={() => {
          // disabled に加えてここでも確かめる（「控えました」の前に先へ進ませない）
          if (confirmed) onContinue();
        }}
        disabled={!confirmed}
        className="h-14 w-full rounded-lg bg-foreground text-lg font-bold text-background disabled:opacity-60"
      >
        {continueLabel}
      </button>
    </section>
  );
}
