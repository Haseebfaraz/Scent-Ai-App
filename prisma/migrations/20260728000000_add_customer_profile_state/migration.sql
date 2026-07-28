-- CreateTable
CREATE TABLE "CustomerProfileState" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "profileJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerProfileState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfileState_conversationId_key" ON "CustomerProfileState"("conversationId");

-- CreateIndex
CREATE INDEX "CustomerProfileState_conversationId_idx" ON "CustomerProfileState"("conversationId");

