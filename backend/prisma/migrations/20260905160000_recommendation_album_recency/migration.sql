-- Preserve old impressions without guessing their release from a recording.
ALTER TABLE "RecommendationExposure" ADD COLUMN "albumKey" TEXT;
