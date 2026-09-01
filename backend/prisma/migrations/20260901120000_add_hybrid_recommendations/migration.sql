-- Soundspan Hybrid v2: shared canonical features, account-scoped exposure
-- history, shadow generations, and recoverable remote-analysis leases.
CREATE TABLE "CanonicalRecording" (
    "id" TEXT NOT NULL,
    "canonicalKey" TEXT NOT NULL,
    "recordingMbid" TEXT,
    "isrc" TEXT,
    "fingerprint" TEXT,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "bpm" DOUBLE PRECISION,
    "key" TEXT,
    "energy" DOUBLE PRECISION,
    "loudness" DOUBLE PRECISION,
    "valence" DOUBLE PRECISION,
    "danceability" DOUBLE PRECISION,
    "arousal" DOUBLE PRECISION,
    "instrumentalness" DOUBLE PRECISION,
    "acousticness" DOUBLE PRECISION,
    "speechiness" DOUBLE PRECISION,
    "moodTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "essentiaGenres" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "analysisStatus" TEXT NOT NULL DEFAULT 'pending',
    "analysisVersion" TEXT,
    "analyzedAt" TIMESTAMP(3),
    "analysisError" TEXT,
    "embeddingStatus" TEXT NOT NULL DEFAULT 'pending',
    "embeddingVersion" TEXT,
    "embeddingAnalyzedAt" TIMESTAMP(3),
    "embeddingError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CanonicalRecording_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "canonical_recording_embeddings" (
    "canonical_recording_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "embedding" vector(512) NOT NULL,
    "analyzed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "canonical_recording_embeddings_pkey"
        PRIMARY KEY ("canonical_recording_id", "space_id")
);

CREATE TABLE "RecommendationGeneration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "mood" TEXT,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "algorithm" TEXT NOT NULL,
    "served" BOOLEAN NOT NULL DEFAULT true,
    "degradedSources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecommendationGeneration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecommendationExposure" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canonicalRecordingId" TEXT,
    "canonicalKey" TEXT NOT NULL,
    "artistKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerTrackId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "score" DOUBLE PRECISION,
    "exposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "playedAt" TIMESTAMP(3),
    "listenedSeconds" DOUBLE PRECISION,
    "completionRatio" DOUBLE PRECISION,
    "outcome" TEXT,
    CONSTRAINT "RecommendationExposure_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalysisAssetLease" (
    "id" TEXT NOT NULL,
    "canonicalRecordingId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerTrackId" TEXT NOT NULL,
    "spoolRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalysisAssetLease_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrackMapping" ADD COLUMN "canonicalRecordingId" TEXT;

CREATE UNIQUE INDEX "CanonicalRecording_canonicalKey_key"
    ON "CanonicalRecording"("canonicalKey");
CREATE UNIQUE INDEX "CanonicalRecording_recordingMbid_key"
    ON "CanonicalRecording"("recordingMbid");
CREATE INDEX "CanonicalRecording_isrc_idx" ON "CanonicalRecording"("isrc");
CREATE INDEX "CanonicalRecording_fingerprint_idx"
    ON "CanonicalRecording"("fingerprint");
CREATE INDEX "CanonicalRecording_analysisStatus_updatedAt_idx"
    ON "CanonicalRecording"("analysisStatus", "updatedAt");
CREATE INDEX "CanonicalRecording_embeddingStatus_embeddingAnalyzedAt_idx"
    ON "CanonicalRecording"("embeddingStatus", "embeddingAnalyzedAt");
CREATE INDEX "canonical_recording_embeddings_space_id_idx"
    ON "canonical_recording_embeddings"("space_id");
CREATE INDEX "RecommendationGeneration_userId_createdAt_idx"
    ON "RecommendationGeneration"("userId", "createdAt");
CREATE INDEX "RecommendationGeneration_algorithm_served_createdAt_idx"
    ON "RecommendationGeneration"("algorithm", "served", "createdAt");
CREATE UNIQUE INDEX "RecommendationExposure_generationId_provider_providerTrackId_key"
    ON "RecommendationExposure"("generationId", "provider", "providerTrackId");
CREATE INDEX "RecommendationExposure_userId_exposedAt_idx"
    ON "RecommendationExposure"("userId", "exposedAt");
CREATE INDEX "RecommendationExposure_userId_canonicalKey_exposedAt_idx"
    ON "RecommendationExposure"("userId", "canonicalKey", "exposedAt");
CREATE INDEX "RecommendationExposure_userId_artistKey_exposedAt_idx"
    ON "RecommendationExposure"("userId", "artistKey", "exposedAt");
CREATE INDEX "RecommendationExposure_userId_provider_providerTrackId_exposedAt_idx"
    ON "RecommendationExposure"("userId", "provider", "providerTrackId", "exposedAt");
CREATE UNIQUE INDEX "AnalysisAssetLease_spoolRef_key"
    ON "AnalysisAssetLease"("spoolRef");
CREATE UNIQUE INDEX "AnalysisAssetLease_active_canonical_unique_idx"
    ON "AnalysisAssetLease"("canonicalRecordingId")
    WHERE "status" IN (
        'downloading',
        'downloaded',
        'queued_essentia',
        'processing',
        'expiring',
        'cleanup_failed'
    );
CREATE INDEX "AnalysisAssetLease_status_expiresAt_idx"
    ON "AnalysisAssetLease"("status", "expiresAt");
CREATE INDEX "AnalysisAssetLease_canonicalRecordingId_createdAt_idx"
    ON "AnalysisAssetLease"("canonicalRecordingId", "createdAt");
CREATE INDEX "TrackMapping_canonicalRecordingId_idx"
    ON "TrackMapping"("canonicalRecordingId");

ALTER TABLE "canonical_recording_embeddings"
    ADD CONSTRAINT "canonical_recording_embeddings_canonical_recording_id_fkey"
    FOREIGN KEY ("canonical_recording_id") REFERENCES "CanonicalRecording"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "canonical_recording_embeddings"
    ADD CONSTRAINT "canonical_recording_embeddings_space_id_fkey"
    FOREIGN KEY ("space_id") REFERENCES "embedding_spaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecommendationGeneration"
    ADD CONSTRAINT "RecommendationGeneration_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationExposure"
    ADD CONSTRAINT "RecommendationExposure_generationId_fkey"
    FOREIGN KEY ("generationId") REFERENCES "RecommendationGeneration"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationExposure"
    ADD CONSTRAINT "RecommendationExposure_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationExposure"
    ADD CONSTRAINT "RecommendationExposure_canonicalRecordingId_fkey"
    FOREIGN KEY ("canonicalRecordingId") REFERENCES "CanonicalRecording"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnalysisAssetLease"
    ADD CONSTRAINT "AnalysisAssetLease_canonicalRecordingId_fkey"
    FOREIGN KEY ("canonicalRecordingId") REFERENCES "CanonicalRecording"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrackMapping"
    ADD CONSTRAINT "TrackMapping_canonicalRecordingId_fkey"
    FOREIGN KEY ("canonicalRecordingId") REFERENCES "CanonicalRecording"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
