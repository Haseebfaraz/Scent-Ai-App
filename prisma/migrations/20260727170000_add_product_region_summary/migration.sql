-- CreateTable
CREATE TABLE "ProductRegionSummary" (
    "id" TEXT NOT NULL,
    "normalizedProductName" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeValue" TEXT NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "distinctCustomerCount" INTEGER NOT NULL,
    "repeatCustomerCount" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductRegionSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductRegionSummary_scope_scopeValue_idx" ON "ProductRegionSummary"("scope", "scopeValue");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRegionSummary_normalizedProductName_scope_scopeValue_key" ON "ProductRegionSummary"("normalizedProductName", "scope", "scopeValue");

