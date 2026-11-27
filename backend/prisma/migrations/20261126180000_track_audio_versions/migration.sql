CREATE TABLE "TrackAudioVersion" (
    "source" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "draftId" TEXT,
    "publishedId" TEXT,
    CONSTRAINT "TrackAudioVersion_pkey" PRIMARY KEY ("source", "trackId")
);

CREATE UNIQUE INDEX "TrackAudioVersion_draftId_key"
    ON "TrackAudioVersion"("draftId");
CREATE UNIQUE INDEX "TrackAudioVersion_publishedId_key"
    ON "TrackAudioVersion"("publishedId");
