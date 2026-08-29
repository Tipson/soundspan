-- Personal collection entries are account-scoped snapshots, not server files.
CREATE TABLE "SavedMusicEntity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedMusicEntity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SavedMusicEntity_userId_entityType_source_entityId_key"
ON "SavedMusicEntity"("userId", "entityType", "source", "entityId");

CREATE INDEX "SavedMusicEntity_userId_entityType_createdAt_idx"
ON "SavedMusicEntity"("userId", "entityType", "createdAt");

ALTER TABLE "SavedMusicEntity"
ADD CONSTRAINT "SavedMusicEntity_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
