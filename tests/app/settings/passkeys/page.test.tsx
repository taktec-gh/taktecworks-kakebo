// src/app/settings/passkeys/page.tsx の「配線」を検証する。
// tests/app/page.test.tsx（ダッシュボード）と同じ方針で、データ層をモックして
// async Server Component を `await PasskeysPage()` してから render する。
//
// 期待値の根拠:
// - docs/steps/pub-2.md 設計判断 3「表示名（userName/userDisplayName）」
//   「設定画面（/settings/passkeys）に、このアカウントの表示名を出す。パスキーの選択画面で
//   自分のアカウントを見分けるため」「同じユーザーなら、サインアップ時も設定画面での
//   追加登録時も同じ表示名になること」
// - docs/steps/pub-2.md 設計判断 8「別の端末で使うときの案内」
//   「設定画面（/settings/passkeys）: 別の端末でも使うには、その端末でログイン
//   （QR コード可）してからこの画面で登録すること」
// - docs/steps/pub-2.md「tester 向けの方針」7.「設定画面の登録: そのユーザーの
//   webauthnUserId と表示名が使われ、他のユーザーの値が使われない」9.（画面の文言）

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPasskeyDisplayName } from "@/lib/webauthn-user-id";

import type { Credential } from "@/generated/prisma/client";
import type { UserId } from "@/lib/user-id";

const USER_ID = "user_1" as UserId;
// 32バイトの手元生成済み固定値（node -e "Buffer.from([1..32]).toString('base64url')"）
const WEBAUTHN_USER_ID = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const OTHER_WEBAUTHN_USER_ID = "__79_Pv6-fj39vX08_Lx8O_u7ezr6uno5-bl5OPi4eA";

vi.mock("next/server", () => ({
  connection: async () => undefined,
}));
vi.mock("@/lib/session", () => ({
  requireUserId: async () => USER_ID,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const listCredentials = vi.fn<() => Promise<Credential[]>>();
const findWebauthnUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/credentials", () => ({
  listCredentials: () => listCredentials(),
}));
vi.mock("@/lib/users", () => ({
  findWebauthnUserId: () => findWebauthnUserId(),
}));

const { default: PasskeysPage } = await import("@/app/settings/passkeys/page");

function makeCredential(overrides: Partial<Credential> = {}): Credential {
  const now = new Date("2026-08-01T00:00:00.000Z");
  return {
    id: "cred_1",
    userId: USER_ID,
    credentialId: "cred-1",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: BigInt(0),
    transports: ["internal"],
    deviceName: "iPhone",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    ...overrides,
  } as Credential;
}

beforeEach(() => {
  listCredentials.mockReset();
  listCredentials.mockResolvedValue([makeCredential(), makeCredential({ id: "cred_2" })]);
  findWebauthnUserId.mockReset();
  findWebauthnUserId.mockResolvedValue(WEBAUTHN_USER_ID);
});

afterEach(() => {
  cleanup();
});

describe("表示名（webauthnUserId から決まる。設計判断 3・7）", () => {
  it("そのユーザーの webauthnUserId から作った表示名を出す", async () => {
    render(await PasskeysPage());
    expect(screen.getByText(getPasskeyDisplayName(WEBAUTHN_USER_ID))).toBeInTheDocument();
  });

  it("他のユーザーの表示名は出さない", async () => {
    render(await PasskeysPage());
    expect(screen.queryByText(getPasskeyDisplayName(OTHER_WEBAUTHN_USER_ID))).not.toBeInTheDocument();
  });

  it("webauthnUserId が見つからない（アカウントが消えた後など）場合は表示名の節を出さない（クラッシュしない）", async () => {
    findWebauthnUserId.mockResolvedValue(null);
    expect(async () => render(await PasskeysPage())).not.toThrow();
  });
});

describe("別の端末での案内（設計判断 8）", () => {
  it("別の端末でログイン（QRコード可）してからこの画面で登録することを案内する", async () => {
    render(await PasskeysPage());
    expect(
      screen.getByText(/その端末でログインしてから.*この画面で「この端末を登録」を押してください/),
    ).toBeInTheDocument();
    expect(screen.getByText(/QR コードで使ってログインできます/)).toBeInTheDocument();
  });
});

describe("1本しかない場合の警告", () => {
  it("1本だけならバックアップの案内を出す", async () => {
    listCredentials.mockResolvedValue([makeCredential()]);
    render(await PasskeysPage());
    expect(screen.getByText(/バックアップ用にもう1台登録してください/)).toBeInTheDocument();
  });

  it("2本以上ならバックアップの案内は出ない", async () => {
    render(await PasskeysPage());
    expect(screen.queryByText(/バックアップ用にもう1台登録してください/)).not.toBeInTheDocument();
  });
});
