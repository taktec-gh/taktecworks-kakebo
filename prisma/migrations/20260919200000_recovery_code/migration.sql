-- 公開版 Step 5（リカバリーコード）。docs/steps/pub-5.md
--
-- User.recoveryCodeHash: 正規化したリカバリーコードの SHA-256（16進）。平文は保存しない。
-- NULL は「コードが無い」（デモユーザー、または未発行）。一意（コードからユーザーを1人に特定する）。
--
-- 既存の行は NULL になる（PostgreSQL の一意索引は NULL 同士を重複として扱わないので、既存の行があっても失敗しない）。

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "recoveryCodeHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_recoveryCodeHash_key" ON "User"("recoveryCodeHash");
