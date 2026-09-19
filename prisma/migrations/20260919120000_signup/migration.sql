-- 公開版 Step 2（サインアップ）。docs/steps/pub-2.md
--
-- 1. User.webauthnUserId（WebAuthn の user handle。32バイトの乱数の base64url。一意）
-- 2. SignupEvent（サインアップのレート制限の記録。userId を持たない）

-- AlterTable
-- 既存の行があっても失敗しないよう、NULL 許容で足す → 乱数で埋める → NOT NULL にする。
-- 埋める値は gen_random_uuid()（PostgreSQL 13 以降の組み込み。拡張不要）2つ分の16進を
-- 32バイトにし、base64url（パディング無し、43文字）にしたもの。アプリが作る値と同じ形式。
-- UUID v4 は固定ビットを含むため乱数は244ビットだが、既存行の埋め合わせ用としては十分。
-- 公開前の時点で既存の行は無い想定（本番 DB は未作成）。
ALTER TABLE "User" ADD COLUMN     "webauthnUserId" TEXT;

UPDATE "User"
SET "webauthnUserId" = rtrim(
  translate(
    encode(
      decode(
        replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
        'hex'
      ),
      'base64'
    ),
    '+/',
    '-_'
  ),
  '='
)
WHERE "webauthnUserId" IS NULL;

ALTER TABLE "User" ALTER COLUMN "webauthnUserId" SET NOT NULL;

-- CreateTable
CREATE TABLE "SignupEvent" (
    "id" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignupEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SignupEvent_createdAt_idx" ON "SignupEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SignupEvent_ipHash_createdAt_idx" ON "SignupEvent"("ipHash", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_webauthnUserId_key" ON "User"("webauthnUserId");
