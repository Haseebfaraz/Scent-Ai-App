-- CreateTable
CREATE TABLE "RecommendationInventorySnapshot" (
    "id" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "inventoryValidated" BOOLEAN NOT NULL,
    "buildable" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "oilTotalMl" DOUBLE PRECISION NOT NULL,
    "alcoholMl" DOUBLE PRECISION NOT NULL,
    "maxBuildableBottles" INTEGER,
    "limitingSku" TEXT,
    "requestStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationInventorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationInventoryComponent" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "fragranceProductId" TEXT,
    "productTitle" TEXT NOT NULL,
    "odooSku" TEXT,
    "ratioPercent" DOUBLE PRECISION NOT NULL,
    "requiredOilMl" DOUBLE PRECISION NOT NULL,
    "onHandQty" DOUBLE PRECISION,
    "mappingStatus" TEXT NOT NULL,
    "sufficient" BOOLEAN,
    "maxBuildableBottlesForComponent" INTEGER,

    CONSTRAINT "RecommendationInventoryComponent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationInventorySnapshot_recommendationId_key" ON "RecommendationInventorySnapshot"("recommendationId");

-- CreateIndex
CREATE INDEX "RecommendationInventorySnapshot_recommendationId_idx" ON "RecommendationInventorySnapshot"("recommendationId");

-- CreateIndex
CREATE INDEX "RecommendationInventoryComponent_snapshotId_idx" ON "RecommendationInventoryComponent"("snapshotId");

-- AddForeignKey
ALTER TABLE "RecommendationInventorySnapshot" ADD CONSTRAINT "RecommendationInventorySnapshot_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "FragranceRecommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationInventoryComponent" ADD CONSTRAINT "RecommendationInventoryComponent_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "RecommendationInventorySnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
