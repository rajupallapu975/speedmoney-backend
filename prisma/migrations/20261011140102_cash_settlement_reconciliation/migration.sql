-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'RECONCILED', 'DISCREPANCY', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SettlementItemStatus" AS ENUM ('INCLUDED', 'RECONCILED', 'DISCREPANCY', 'EXCLUDED');

-- CreateTable
CREATE TABLE "CashSettlement" (
    "id" TEXT NOT NULL,
    "settlementReference" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "agentId" TEXT,
    "expectedAmount" DECIMAL(12,2) NOT NULL,
    "actualAmount" DECIMAL(12,2),
    "discrepancyAmount" DECIMAL(12,2),
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "discrepancyReason" TEXT,
    "createdById" TEXT NOT NULL,
    "reconciledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "countedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),

    CONSTRAINT "CashSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashSettlementItem" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "cashCollectionId" TEXT NOT NULL,
    "recordedAmount" DECIMAL(12,2) NOT NULL,
    "status" "SettlementItemStatus" NOT NULL DEFAULT 'INCLUDED',
    "discrepancyReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashSettlementItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashSettlement_settlementReference_key" ON "CashSettlement"("settlementReference");

-- CreateIndex
CREATE INDEX "CashSettlement_businessDate_idx" ON "CashSettlement"("businessDate");

-- CreateIndex
CREATE INDEX "CashSettlement_agentId_idx" ON "CashSettlement"("agentId");

-- CreateIndex
CREATE INDEX "CashSettlement_status_idx" ON "CashSettlement"("status");

-- CreateIndex
CREATE INDEX "CashSettlement_createdById_idx" ON "CashSettlement"("createdById");

-- CreateIndex
CREATE INDEX "CashSettlementItem_settlementId_idx" ON "CashSettlementItem"("settlementId");

-- CreateIndex
CREATE INDEX "CashSettlementItem_cashCollectionId_idx" ON "CashSettlementItem"("cashCollectionId");

-- CreateIndex
CREATE INDEX "CashSettlementItem_status_idx" ON "CashSettlementItem"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CashSettlementItem_settlementId_cashCollectionId_key" ON "CashSettlementItem"("settlementId", "cashCollectionId");

-- AddForeignKey
ALTER TABLE "CashSettlement" ADD CONSTRAINT "CashSettlement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSettlement" ADD CONSTRAINT "CashSettlement_reconciledById_fkey" FOREIGN KEY ("reconciledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSettlement" ADD CONSTRAINT "CashSettlement_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSettlementItem" ADD CONSTRAINT "CashSettlementItem_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "CashSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSettlementItem" ADD CONSTRAINT "CashSettlementItem_cashCollectionId_fkey" FOREIGN KEY ("cashCollectionId") REFERENCES "CashCollection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
