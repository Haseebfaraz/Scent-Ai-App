-- AlterTable
ALTER TABLE "OrderHistory" ADD COLUMN     "customerKeyHash" TEXT,
ADD COLUMN     "normalizedProductName" TEXT,
ADD COLUMN     "productName" TEXT;

-- CreateTable
CREATE TABLE "FragranceProduct" (
    "id" TEXT NOT NULL,
    "handle" TEXT,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "notesRaw" TEXT,
    "notesJson" JSONB,
    "fragranceFamily" TEXT,
    "collection" TEXT,
    "pricePer5ml" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FragranceProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExistingCombination" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "componentProductsJson" JSONB NOT NULL,
    "componentKey" TEXT NOT NULL,
    "tagLine" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExistingCombination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FragranceRecommendation" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "customerProfileJson" JSONB NOT NULL,
    "productsJson" JSONB NOT NULL,
    "combinationType" TEXT NOT NULL,
    "scoreJson" JSONB NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "ratiosJson" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "shopifyProductId" TEXT,

    CONSTRAINT "FragranceRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FragranceProduct_normalizedTitle_key" ON "FragranceProduct"("normalizedTitle");

-- CreateIndex
CREATE INDEX "FragranceProduct_fragranceFamily_idx" ON "FragranceProduct"("fragranceFamily");

-- CreateIndex
CREATE INDEX "FragranceProduct_collection_idx" ON "FragranceProduct"("collection");

-- CreateIndex
CREATE UNIQUE INDEX "ExistingCombination_componentKey_key" ON "ExistingCombination"("componentKey");

-- CreateIndex
CREATE INDEX "ExistingCombination_type_idx" ON "ExistingCombination"("type");

-- CreateIndex
CREATE INDEX "FragranceRecommendation_conversationId_idx" ON "FragranceRecommendation"("conversationId");

-- CreateIndex
CREATE INDEX "FragranceRecommendation_status_idx" ON "FragranceRecommendation"("status");

-- CreateIndex
CREATE INDEX "OrderHistory_normalizedProductName_idx" ON "OrderHistory"("normalizedProductName");

-- CreateIndex
CREATE INDEX "OrderHistory_customerKeyHash_idx" ON "OrderHistory"("customerKeyHash");

