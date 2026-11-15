-- Additive defaults preserve writes by the prior API image during rollback.
ALTER TABLE "User" ADD COLUMN "playHistoryEpoch" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "playReceiptPrunedThrough" TIMESTAMP(3);
CREATE TYPE "LocalPlayAttributionState" AS ENUM ('LEGACY', 'APPLIED', 'NO_TARGET');
ALTER TABLE "Play" ADD COLUMN "localAttributionState" "LocalPlayAttributionState" NOT NULL DEFAULT 'LEGACY',
    ADD COLUMN "attributedExposureId" TEXT;
ALTER TABLE "RecommendationExposure" ADD COLUMN "lastPlayAt" TIMESTAMP(3), ADD COLUMN "lastPlayId" TEXT;
CREATE TABLE "PlayCreationReceipt" (
    "userId" TEXT NOT NULL,
    "clientPlaybackId" TEXT NOT NULL,
    "requestHash" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "playId" TEXT,
    CONSTRAINT "PlayCreationReceipt_pkey" PRIMARY KEY ("userId", "clientPlaybackId")
);
CREATE UNIQUE INDEX "PlayCreationReceipt_playId_key" ON "PlayCreationReceipt"("playId");
CREATE INDEX "PlayCreationReceipt_userId_expiresAt_idx" ON "PlayCreationReceipt"("userId", "expiresAt");
CREATE INDEX "Play_attributedExposureId_idx" ON "Play"("attributedExposureId");
ALTER TABLE "PlayCreationReceipt" ADD CONSTRAINT "PlayCreationReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayCreationReceipt" ADD CONSTRAINT "PlayCreationReceipt_playId_fkey" FOREIGN KEY ("playId") REFERENCES "Play"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Play" ADD CONSTRAINT "Play_attributedExposureId_fkey" FOREIGN KEY ("attributedExposureId") REFERENCES "RecommendationExposure"("id") ON DELETE SET NULL ON UPDATE CASCADE;
