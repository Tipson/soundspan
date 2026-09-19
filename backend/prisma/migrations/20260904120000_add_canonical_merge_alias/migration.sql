-- Preserve merged canonical rows as metadata aliases that point at the one
-- surviving recording. Restricting survivor deletion prevents aliases from
-- silently becoming live canonical rows again.
ALTER TABLE "CanonicalRecording" ADD COLUMN "mergedIntoId" TEXT;

CREATE INDEX "CanonicalRecording_mergedIntoId_idx"
    ON "CanonicalRecording"("mergedIntoId");

ALTER TABLE "CanonicalRecording"
    ADD CONSTRAINT "CanonicalRecording_mergedIntoId_fkey"
    FOREIGN KEY ("mergedIntoId") REFERENCES "CanonicalRecording"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Historical merges did not store their survivor. Recommendation exposures
-- retain both the old canonical key and the post-merge canonical id, so use
-- only a single distinct, still-live target as unambiguous backfill evidence.
WITH unambiguous_survivors AS (
    SELECT
        source."id" AS source_id,
        MIN(exposure."canonicalRecordingId") AS target_id
    FROM "CanonicalRecording" AS source
    JOIN "RecommendationExposure" AS exposure
      ON exposure."canonicalKey" = source."canonicalKey"
     AND exposure."canonicalRecordingId" IS NOT NULL
     AND exposure."canonicalRecordingId" <> source."id"
    JOIN "CanonicalRecording" AS target
      ON target."id" = exposure."canonicalRecordingId"
     AND target."identitySource" <> 'identity-merged'
    WHERE source."identitySource" = 'identity-merged'
    GROUP BY source."id"
    HAVING COUNT(DISTINCT exposure."canonicalRecordingId") = 1
)
UPDATE "CanonicalRecording" AS source
SET "mergedIntoId" = survivor.target_id,
    "identityLookupStatus" = 'completed',
    "identityLookupError" = NULL,
    "identityLookupUpdatedAt" = NOW()
FROM unambiguous_survivors AS survivor
WHERE source."id" = survivor.source_id;

-- Anti-repeat and taste training use the durable key as well as the relation.
-- Normalize history only for aliases whose survivor was proven above.
UPDATE "RecommendationExposure" AS exposure
SET "canonicalKey" = target."canonicalKey"
FROM "CanonicalRecording" AS source
JOIN "CanonicalRecording" AS target
  ON target."id" = source."mergedIntoId"
WHERE source."identitySource" = 'identity-merged'
  AND source."mergedIntoId" IS NOT NULL
  AND exposure."canonicalRecordingId" = target."id"
  AND exposure."canonicalKey" = source."canonicalKey";

-- Ambiguous legacy rows remain intact and deliberately unresolved. Runtime
-- refuses to attach new provider mappings to them instead of guessing.
UPDATE "CanonicalRecording"
SET "identityLookupStatus" = 'failed',
    "identityLookupError" = 'Legacy canonical merge target is ambiguous or unavailable',
    "identityLookupUpdatedAt" = NOW()
WHERE "identitySource" = 'identity-merged'
  AND "mergedIntoId" IS NULL;
