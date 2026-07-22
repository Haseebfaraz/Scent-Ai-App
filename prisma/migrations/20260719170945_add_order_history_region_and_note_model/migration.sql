-- AlterTable
ALTER TABLE "OrderHistory" ADD COLUMN "city" TEXT;
ALTER TABLE "OrderHistory" ADD COLUMN "countryName" TEXT;
ALTER TABLE "OrderHistory" ADD COLUMN "stateName" TEXT;

-- CreateIndex
CREATE INDEX "OrderHistory_city_idx" ON "OrderHistory"("city");

-- CreateIndex
CREATE INDEX "OrderHistory_stateName_idx" ON "OrderHistory"("stateName");

-- CreateIndex
CREATE INDEX "OrderHistory_countryName_idx" ON "OrderHistory"("countryName");
