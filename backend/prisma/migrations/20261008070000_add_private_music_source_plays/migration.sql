-- Direct-provider metadata is private activity, not mutable global catalog data.
ALTER TYPE "ListenSource" ADD VALUE 'VK';
ALTER TYPE "ListenSource" ADD VALUE 'YANDEX';

CREATE TABLE "TrackMusicSource" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerTrackId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackMusicSource_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrackMusicSource_identity_check" CHECK (
        ("provider" = 'vk' AND "providerTrackId" ~ '^-?[0-9]{1,20}_[0-9]{1,20}$') OR
        ("provider" = 'yandex' AND "providerTrackId" ~ '^[0-9]{1,20}$')
    )
);
CREATE UNIQUE INDEX "TrackMusicSource_provider_providerTrackId_key"
    ON "TrackMusicSource"("provider", "providerTrackId");

ALTER TABLE "Play"
    ADD COLUMN "trackMusicSourceId" TEXT,
    ADD COLUMN "musicSourceRecording" JSONB;
CREATE INDEX "Play_trackMusicSourceId_idx" ON "Play"("trackMusicSourceId");
ALTER TABLE "Play" ADD CONSTRAINT "Play_trackMusicSourceId_fkey"
    FOREIGN KEY ("trackMusicSourceId") REFERENCES "TrackMusicSource"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Compare enum text: PostgreSQL forbids using freshly added enum values before commit.
-- Deleted namespace references may be null; their owner's immutable snapshot survives.
-- Existing legacy rows, including rows with deleted references, retain their old contract.
ALTER TABLE "Play" ADD CONSTRAINT "Play_musicSourceRecording_check" CHECK ((
    ("trackMusicSourceId" IS NULL AND "musicSourceRecording" IS NULL AND "source"::text NOT IN ('VK', 'YANDEX')) OR
    ("musicSourceRecording" IS NOT NULL AND jsonb_typeof("musicSourceRecording") = 'object'
        AND "source"::text IN ('VK', 'YANDEX')
        AND "trackId" IS NULL AND "trackTidalId" IS NULL AND "trackYtMusicId" IS NULL
        AND "musicSourceRecording" ? 'provider' AND "musicSourceRecording" ? 'id'
        AND (("source"::text = 'VK' AND "musicSourceRecording"->>'provider' = 'vk'
                AND "musicSourceRecording"->>'id' ~ '^-?[0-9]{1,20}_[0-9]{1,20}$') OR
             ("source"::text = 'YANDEX' AND "musicSourceRecording"->>'provider' = 'yandex'
                AND "musicSourceRecording"->>'id' ~ '^[0-9]{1,20}$')))
) IS TRUE);
