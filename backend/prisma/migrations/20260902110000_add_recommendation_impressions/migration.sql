-- Distinguish server-generated candidates from recommendations that actually
-- entered the user's viewport, and retain direct play-to-generation lineage.
ALTER TABLE "RecommendationExposure" ADD COLUMN "viewedAt" TIMESTAMP(3);
ALTER TABLE "Play" ADD COLUMN "recommendationGenerationId" TEXT;
ALTER TABLE "Play" ADD COLUMN "recommendationSessionId" TEXT;
ALTER TABLE "CanonicalRecording"
    ADD COLUMN "identitySource" TEXT NOT NULL DEFAULT 'metadata',
    ADD COLUMN "identityConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    ADD COLUMN "identityVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "identityLookupStatus" TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN "identityLookupRetryCount" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "identityLookupError" TEXT,
    ADD COLUMN "identityLookupUpdatedAt" TIMESTAMP(3);
ALTER TABLE "RecommendationGeneration" ADD COLUMN "context" JSONB;

CREATE INDEX "RecommendationExposure_userId_viewedAt_idx"
    ON "RecommendationExposure"("userId", "viewedAt");
CREATE INDEX "CanonicalRecording_identityLookupStatus_identityLookupUpdatedAt_idx"
    ON "CanonicalRecording"("identityLookupStatus", "identityLookupUpdatedAt");
CREATE INDEX "Play_recommendationGenerationId_idx"
    ON "Play"("recommendationGenerationId");
CREATE INDEX "Play_userId_recommendationSessionId_playedAt_idx"
    ON "Play"("userId", "recommendationSessionId", "playedAt");

ALTER TABLE "Play"
    ADD CONSTRAINT "Play_recommendationGenerationId_fkey"
    FOREIGN KEY ("recommendationGenerationId")
    REFERENCES "RecommendationGeneration"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
