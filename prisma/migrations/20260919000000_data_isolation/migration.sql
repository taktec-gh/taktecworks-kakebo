-- DropForeignKey
ALTER TABLE "Expense" DROP CONSTRAINT "Expense_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "Expense" DROP CONSTRAINT "Expense_paymentSourceId_fkey";

-- DropForeignKey
ALTER TABLE "Budget" DROP CONSTRAINT "Budget_paymentSourceId_fkey";

-- DropForeignKey
ALTER TABLE "CategoryBudget" DROP CONSTRAINT "CategoryBudget_categoryId_fkey";

-- DropIndex
DROP INDEX "PaymentSource_name_key";

-- DropIndex
DROP INDEX "PaymentSource_isDefault_key";

-- DropIndex
DROP INDEX "Category_name_key";

-- DropIndex
DROP INDEX "Expense_date_idx";

-- DropIndex
DROP INDEX "Expense_date_categoryId_idx";

-- DropIndex
DROP INDEX "Expense_date_paymentSourceId_idx";

-- DropIndex
DROP INDEX "Budget_yearMonth_idx";

-- DropIndex
DROP INDEX "CategoryBudget_yearMonth_idx";

-- DropIndex
DROP INDEX "Income_yearMonth_idx";

-- AlterTable
ALTER TABLE "PaymentSource" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "CategoryBudget" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Income" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Credential" ADD COLUMN     "userId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSource_id_userId_key" ON "PaymentSource"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSource_userId_name_key" ON "PaymentSource"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSource_userId_isDefault_key" ON "PaymentSource"("userId", "isDefault") WHERE ("isDefault" = true);

-- CreateIndex
CREATE UNIQUE INDEX "Category_id_userId_key" ON "Category"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_userId_name_key" ON "Category"("userId", "name");

-- CreateIndex
CREATE INDEX "Expense_userId_date_idx" ON "Expense"("userId", "date");

-- CreateIndex
CREATE INDEX "Expense_userId_date_categoryId_idx" ON "Expense"("userId", "date", "categoryId");

-- CreateIndex
CREATE INDEX "Expense_userId_date_paymentSourceId_idx" ON "Expense"("userId", "date", "paymentSourceId");

-- CreateIndex
CREATE INDEX "Budget_userId_yearMonth_idx" ON "Budget"("userId", "yearMonth");

-- CreateIndex
CREATE INDEX "CategoryBudget_userId_yearMonth_idx" ON "CategoryBudget"("userId", "yearMonth");

-- CreateIndex
CREATE INDEX "Income_userId_yearMonth_idx" ON "Income"("userId", "yearMonth");

-- CreateIndex
CREATE INDEX "Credential_userId_idx" ON "Credential"("userId");

-- AddForeignKey
ALTER TABLE "PaymentSource" ADD CONSTRAINT "PaymentSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_userId_fkey" FOREIGN KEY ("categoryId", "userId") REFERENCES "Category"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_paymentSourceId_userId_fkey" FOREIGN KEY ("paymentSourceId", "userId") REFERENCES "PaymentSource"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_paymentSourceId_userId_fkey" FOREIGN KEY ("paymentSourceId", "userId") REFERENCES "PaymentSource"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryBudget" ADD CONSTRAINT "CategoryBudget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryBudget" ADD CONSTRAINT "CategoryBudget_categoryId_userId_fkey" FOREIGN KEY ("categoryId", "userId") REFERENCES "Category"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Income" ADD CONSTRAINT "Income_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
