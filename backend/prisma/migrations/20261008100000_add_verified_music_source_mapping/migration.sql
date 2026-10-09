-- Direct identities have a separate linkage domain. Preserve every legacy row.
ALTER TABLE "TrackMapping" ADD COLUMN "trackMusicSourceId" TEXT;

ALTER TABLE "TrackMapping"
    DROP CONSTRAINT "TrackMapping_requires_linkage_chk";
ALTER TABLE "TrackMapping"
    ADD CONSTRAINT "TrackMapping_requires_linkage_chk"
    CHECK (
        (
            "trackMusicSourceId" IS NULL
            AND (
                "trackId" IS NOT NULL
                OR "trackTidalId" IS NOT NULL
                OR "trackYtMusicId" IS NOT NULL
            )
        )
        OR (
            "trackMusicSourceId" IS NOT NULL
            AND "trackId" IS NULL
            AND "trackTidalId" IS NULL
            AND "trackYtMusicId" IS NULL
        )
    );

DROP INDEX "TrackMapping_active_linkage_tuple_unique_idx";
CREATE UNIQUE INDEX "TrackMapping_active_linkage_tuple_unique_idx"
    ON "TrackMapping" (
        COALESCE("trackId", '__NULL__'),
        COALESCE("trackTidalId", '__NULL__'),
        COALESCE("trackYtMusicId", '__NULL__')
    )
    WHERE "stale" = false AND "trackMusicSourceId" IS NULL;

CREATE UNIQUE INDEX "TrackMapping_active_music_source_unique_idx"
    ON "TrackMapping"("trackMusicSourceId")
    WHERE "stale" = false AND "trackMusicSourceId" IS NOT NULL;
CREATE INDEX "TrackMapping_trackMusicSourceId_idx"
    ON "TrackMapping"("trackMusicSourceId");

-- Removing a namespace removes only its mapping. Canonical identity and private Play survive.
ALTER TABLE "TrackMapping"
    ADD CONSTRAINT "TrackMapping_trackMusicSourceId_fkey"
    FOREIGN KEY ("trackMusicSourceId") REFERENCES "TrackMusicSource"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
