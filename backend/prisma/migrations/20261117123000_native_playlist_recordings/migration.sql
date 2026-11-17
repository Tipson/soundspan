ALTER TABLE "PlaylistItem"
ADD COLUMN "trackMusicSourceId" TEXT,
ADD COLUMN "musicSourceRecording" JSONB;

CREATE UNIQUE INDEX "PlaylistItem_playlistId_trackMusicSourceId_sort_key"
ON "PlaylistItem"("playlistId", "trackMusicSourceId", "sort");

CREATE INDEX "PlaylistItem_trackMusicSourceId_idx"
ON "PlaylistItem"("trackMusicSourceId");

ALTER TABLE "PlaylistItem"
ADD CONSTRAINT "PlaylistItem_trackMusicSourceId_fkey"
FOREIGN KEY ("trackMusicSourceId") REFERENCES "TrackMusicSource"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PlaylistItem"
ADD CONSTRAINT "PlaylistItem_native_recording_exclusive"
CHECK (
    ("trackMusicSourceId" IS NULL AND "musicSourceRecording" IS NULL)
    OR (
        "musicSourceRecording" IS NOT NULL
        AND "trackId" IS NULL
        AND "trackTidalId" IS NULL
        AND "trackYtMusicId" IS NULL
    )
);
