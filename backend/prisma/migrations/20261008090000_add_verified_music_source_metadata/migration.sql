-- Additive server attestation. Existing namespaces remain unverified and private Play snapshots are untouched.
ALTER TABLE "TrackMusicSource"
    ADD COLUMN "verifiedMetadata" JSONB,
    ADD COLUMN "metadataObservedAt" TIMESTAMP(3),
    ADD COLUMN "metadataConnectionVersion" INTEGER;

-- Enforce tuple coherence, bounded allowlisted JSON and exact namespace identity even for non-ORM writes.
-- The application also validates individual artist lengths and trims display strings before writing.
ALTER TABLE "TrackMusicSource" ADD CONSTRAINT "TrackMusicSource_verified_metadata_check" CHECK (
    (
        ("verifiedMetadata" IS NULL AND "metadataObservedAt" IS NULL AND "metadataConnectionVersion" IS NULL)
        OR (
            "verifiedMetadata" IS NOT NULL AND "metadataObservedAt" IS NOT NULL
            AND "metadataConnectionVersion" > 0
            AND jsonb_typeof("verifiedMetadata") = 'object'
            AND octet_length("verifiedMetadata"::text) <= 8192
            AND ("verifiedMetadata" - ARRAY['provider', 'id', 'title', 'artists', 'duration', 'contentVersion', 'preview', 'isrc']) = '{}'::jsonb
            AND "verifiedMetadata"->>'provider' = "provider"
            AND "verifiedMetadata"->>'id' = "providerTrackId"
            AND jsonb_typeof("verifiedMetadata"->'title') = 'string'
            AND length(btrim("verifiedMetadata"->>'title')) BETWEEN 1 AND 200
            AND CASE WHEN jsonb_typeof("verifiedMetadata"->'artists') = 'array'
                THEN jsonb_array_length("verifiedMetadata"->'artists') BETWEEN 1 AND 10
                    AND NOT jsonb_path_exists("verifiedMetadata", '$.artists[*] ? (@.type() != "string")')
                ELSE false END
            AND CASE WHEN jsonb_typeof("verifiedMetadata"->'duration') = 'number'
                THEN ("verifiedMetadata"->>'duration')::numeric > 0 AND ("verifiedMetadata"->>'duration')::numeric <= 3600
                ELSE false END
            AND "verifiedMetadata"->>'contentVersion' IN ('explicit', 'clean', 'unknown')
            AND "verifiedMetadata"->'preview' = 'false'::jsonb
            AND (NOT ("verifiedMetadata" ? 'isrc') OR (
                jsonb_typeof("verifiedMetadata"->'isrc') = 'string'
                AND "verifiedMetadata"->>'isrc' ~ '^[A-Za-z]{2}[A-Za-z0-9]{3}[0-9]{7}$'
            ))
        )
    ) IS TRUE
);
