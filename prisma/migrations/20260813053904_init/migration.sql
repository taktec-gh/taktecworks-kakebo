-- CreateEnum
CREATE TYPE "PaymentSourceType" AS ENUM ('CASH', 'CREDIT_CARD', 'BANK_DEBIT');

-- CreateEnum
CREATE TYPE "WasteTag" AS ENUM ('NECESSARY', 'WASTE', 'INVESTMENT');

-- CreateEnum
CREATE TYPE "CostType" AS ENUM ('FIXED', 'VARIABLE');

-- CreateTable
CREATE TABLE "PaymentSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PaymentSourceType" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "costType" "CostType" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amountYen" INTEGER NOT NULL,
    "categoryId" TEXT NOT NULL,
    "paymentSourceId" TEXT NOT NULL,
    "storeName" TEXT,
    "memo" TEXT,
    "wasteTag" "WasteTag" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "paymentSourceId" TEXT NOT NULL,
    "yearMonth" CHAR(7) NOT NULL,
    "amountYen" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryBudget" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "yearMonth" CHAR(7) NOT NULL,
    "amountYen" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Income" (
    "id" TEXT NOT NULL,
    "yearMonth" CHAR(7) NOT NULL,
    "amountYen" INTEGER NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Income_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSource_name_key" ON "PaymentSource"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSource_isDefault_key" ON "PaymentSource"("isDefault") WHERE ("isDefault" = true);

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE INDEX "Expense_date_idx" ON "Expense"("date");

-- CreateIndex
CREATE INDEX "Expense_date_categoryId_idx" ON "Expense"("date", "categoryId");

-- CreateIndex
CREATE INDEX "Expense_date_paymentSourceId_idx" ON "Expense"("date", "paymentSourceId");

-- CreateIndex
CREATE INDEX "Budget_yearMonth_idx" ON "Budget"("yearMonth");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_paymentSourceId_yearMonth_key" ON "Budget"("paymentSourceId", "yearMonth");

-- CreateIndex
CREATE INDEX "CategoryBudget_yearMonth_idx" ON "CategoryBudget"("yearMonth");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryBudget_categoryId_yearMonth_key" ON "CategoryBudget"("categoryId", "yearMonth");

-- CreateIndex
CREATE INDEX "Income_yearMonth_idx" ON "Income"("yearMonth");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_paymentSourceId_fkey" FOREIGN KEY ("paymentSourceId") REFERENCES "PaymentSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_paymentSourceId_fkey" FOREIGN KEY ("paymentSourceId") REFERENCES "PaymentSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryBudget" ADD CONSTRAINT "CategoryBudget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
