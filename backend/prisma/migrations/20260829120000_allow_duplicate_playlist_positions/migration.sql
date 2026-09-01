-- Playlist entries are ordered occurrences: the same track may intentionally
-- appear more than once, but an exact reference cannot occupy one position twice.
DROP INDEX IF EXISTS "PlaylistItem_playlistId_trackId_key";
DROP INDEX IF EXISTS "PlaylistItem_playlistId_trackTidalId_key";
DROP INDEX IF EXISTS "PlaylistItem_playlistId_trackYtMusicId_key";

CREATE UNIQUE INDEX "PlaylistItem_playlistId_trackId_sort_key"
    ON "PlaylistItem" ("playlistId", "trackId", "sort");

CREATE UNIQUE INDEX "PlaylistItem_playlistId_trackTidalId_sort_key"
    ON "PlaylistItem" ("playlistId", "trackTidalId", "sort");

CREATE UNIQUE INDEX "PlaylistItem_playlistId_trackYtMusicId_sort_key"
    ON "PlaylistItem" ("playlistId", "trackYtMusicId", "sort");
