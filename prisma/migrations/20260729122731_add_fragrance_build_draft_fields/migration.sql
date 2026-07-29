-- AlterTable
ALTER TABLE "FragranceRecommendation" ADD COLUMN     "buildStatus" TEXT NOT NULL DEFAULT 'draft',
ADD COLUMN     "draftExcludedNotes" JSONB,
ADD COLUMN     "draftName" TEXT,
ADD COLUMN     "draftRatiosJson" JSONB,
ADD COLUMN     "shopifyVariantId" TEXT;
