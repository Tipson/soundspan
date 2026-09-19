-- AcoustID lookup runs in Python, but all canonical identity promotion and
-- merge mutations are owned by the TypeScript durable identity transaction.
-- This table is the durable, replayable handoff between those runtimes.
CREATE TABLE "CanonicalIdentityPromotionIntent" (
    "id" TEXT NOT NULL,
    "sourceCanonicalId" TEXT NOT NULL,
    "expectedFingerprint" TEXT NOT NULL,
    "fingerprintHash" TEXT NOT NULL,
    "recordingMbid" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanonicalIdentityPromotionIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CanonicalIdentityPromotionIntent_sourceCanonicalId_fingerprintHash_recordingMbid_key"
    ON "CanonicalIdentityPromotionIntent"("sourceCanonicalId", "fingerprintHash", "recordingMbid");

CREATE INDEX "CanonicalIdentityPromotionIntent_status_availableAt_createdAt_idx"
    ON "CanonicalIdentityPromotionIntent"("status", "availableAt", "createdAt");

CREATE INDEX "CanonicalIdentityPromotionIntent_sourceCanonicalId_createdAt_idx"
    ON "CanonicalIdentityPromotionIntent"("sourceCanonicalId", "createdAt");

ALTER TABLE "CanonicalIdentityPromotionIntent"
    ADD CONSTRAINT "CanonicalIdentityPromotionIntent_sourceCanonicalId_fkey"
    FOREIGN KEY ("sourceCanonicalId") REFERENCES "CanonicalRecording"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Older analyzer pods used a marker without a survivor relation. Quarantine
-- pre-existing rows and reject any new mixed-version write that would make an
-- alias look live. Current TypeScript merges always write mergedIntoId in the
-- same transaction; explicitly failed ambiguous legacy rows remain readable.
UPDATE "CanonicalRecording"
SET "identitySource" = 'identity-merged',
    "identityLookupStatus" = 'failed',
    "identityLookupError" = 'Legacy AcoustID merge target is ambiguous or unavailable',
    "identityLookupUpdatedAt" = NOW(),
    "updatedAt" = NOW()
WHERE "identitySource" = 'acoustid-merged'
  AND "mergedIntoId" IS NULL;

ALTER TABLE "CanonicalRecording"
    ADD CONSTRAINT "CanonicalRecording_merge_alias_has_survivor_or_failed_check"
    CHECK (
        "identitySource" NOT IN ('identity-merged', 'acoustid-merged')
        OR "mergedIntoId" IS NOT NULL
        OR "identityLookupStatus" = 'failed'
    );
