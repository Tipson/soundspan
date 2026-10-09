-- Exact direct likes share the existing per-owner preference lifecycle.
-- Preserve every legacy row, including historical null/multi-key tuples.
ALTER TABLE "LikedRemoteTrack" ADD COLUMN "trackMusicSourceId" TEXT;

ALTER TABLE "LikedRemoteTrack" ADD CONSTRAINT "LikedRemoteTrack_direct_linkage_check"
    CHECK (
        "trackMusicSourceId" IS NULL OR
        ("trackTidalId" IS NULL AND "trackYtMusicId" IS NULL)
    );

CREATE UNIQUE INDEX "LikedRemoteTrack_userId_trackMusicSourceId_key"
    ON "LikedRemoteTrack"("userId", "trackMusicSourceId");
CREATE INDEX "LikedRemoteTrack_trackMusicSourceId_idx"
    ON "LikedRemoteTrack"("trackMusicSourceId");

ALTER TABLE "LikedRemoteTrack" ADD CONSTRAINT "LikedRemoteTrack_trackMusicSourceId_fkey"
    FOREIGN KEY ("trackMusicSourceId") REFERENCES "TrackMusicSource"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
