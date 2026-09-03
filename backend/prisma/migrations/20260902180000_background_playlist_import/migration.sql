-- Preserve duplicate source occurrences by making the original playlist
-- position, rather than artist/title metadata, the pending-row identity.
DROP INDEX IF EXISTS "PlaylistPendingTrack_playlistId_spotifyArtist_spotifyTitle_key";

-- Legacy rows were not position-unique. Keep the first row at an ambiguous
-- position and append only additional collisions after the playlist's current
-- maximum, so an upgrade cannot fail while no pending occurrence is discarded.
WITH duplicate_rows AS (
    SELECT
        "id",
        "playlistId",
        ROW_NUMBER() OVER (
            PARTITION BY "playlistId"
            ORDER BY "sort", "createdAt", "id"
        ) AS duplicate_ordinal,
        max_sort
    FROM (
        SELECT
            pending.*,
            ROW_NUMBER() OVER (
                PARTITION BY "playlistId", "sort"
                ORDER BY "createdAt", "id"
            ) AS position_ordinal,
            MAX("sort") OVER (PARTITION BY "playlistId") AS max_sort
        FROM "PlaylistPendingTrack" AS pending
    ) AS ranked_positions
    WHERE position_ordinal > 1
)
UPDATE "PlaylistPendingTrack" AS pending
SET "sort" = duplicate_rows.max_sort + duplicate_rows.duplicate_ordinal
FROM duplicate_rows
WHERE pending."id" = duplicate_rows."id";

CREATE UNIQUE INDEX "PlaylistPendingTrack_playlistId_sort_key"
    ON "PlaylistPendingTrack" ("playlistId", "sort");

-- Persist enough timing and progress state to resume background resolution and
-- report an ETA without depending on one worker process remaining alive.
ALTER TABLE "ImportJob"
    ADD COLUMN "resolutionStartedAt" TIMESTAMP(3),
    ADD COLUMN "resolutionProcessed" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "resolutionAttempt" INTEGER NOT NULL DEFAULT 0;
