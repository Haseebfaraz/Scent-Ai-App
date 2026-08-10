-- CreateTable
CREATE TABLE "OdooOilMapping" (
    "id" TEXT NOT NULL,
    "fragranceProductId" TEXT NOT NULL,
    "odooSku" TEXT NOT NULL,
    "odooProductId" INTEGER,
    "odooVariantId" INTEGER,
    "odooName" TEXT,
    "unitOfMeasure" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OdooOilMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OdooOilMapping_fragranceProductId_key" ON "OdooOilMapping"("fragranceProductId");

-- CreateIndex
CREATE UNIQUE INDEX "OdooOilMapping_odooSku_key" ON "OdooOilMapping"("odooSku");

-- CreateIndex
CREATE INDEX "OdooOilMapping_odooSku_idx" ON "OdooOilMapping"("odooSku");
