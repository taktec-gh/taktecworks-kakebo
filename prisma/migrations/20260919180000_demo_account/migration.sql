-- 公開版 Step 3（デモアカウント）。docs/steps/pub-3.md
--
-- 1. User.demoExpiresAt（NULL なら通常のユーザー、値があればデモユーザーの期限）と、その索引
-- 2. DemoEvent（デモ作成のレート制限の記録。userId を持たない）
--
-- 既存の行は demoExpiresAt が NULL（＝通常のユーザー）になる。期限切れの削除の対象にならない。

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "demoExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DemoEvent" (
    "id" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemoEvent_createdAt_idx" ON "DemoEvent"("createdAt");

-- CreateIndex
CREATE INDEX "DemoEvent_ipHash_createdAt_idx" ON "DemoEvent"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "User_demoExpiresAt_idx" ON "User"("demoExpiresAt");
