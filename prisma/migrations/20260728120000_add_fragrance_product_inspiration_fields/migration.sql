-- AlterTable
ALTER TABLE "FragranceProduct" ADD COLUMN     "inspirationBrand" TEXT,
ADD COLUMN     "inspirationName" TEXT,
ADD COLUMN     "isSingleInspiration" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tagLine" TEXT;

