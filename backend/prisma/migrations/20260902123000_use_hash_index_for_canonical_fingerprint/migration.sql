-- Chromaprint payloads commonly exceed PostgreSQL's B-tree index row limit.
-- Hash indexes retain efficient equality lookup while storing only the hash.
DROP INDEX IF EXISTS "CanonicalRecording_fingerprint_idx";
CREATE INDEX "CanonicalRecording_fingerprint_idx"
    ON "CanonicalRecording" USING HASH (fingerprint);
