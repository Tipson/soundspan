-- Retire the inactive TIDAL runtime while preserving historical provider rows
-- and foreign keys needed to reconcile old playlists with playable sources.
UPDATE "UserSettings"
SET
    "showTidalExplore" = false,
    "tidalOAuthJson" = NULL;

UPDATE "SystemSettings"
SET
    "tidalEnabled" = false,
    "tidalAccessToken" = NULL,
    "tidalRefreshToken" = NULL,
    "tidalUserId" = NULL,
    "downloadSource" = CASE
        WHEN "downloadSource" = 'tidal' AND "ytMusicEnabled" = true THEN 'youtube'
        WHEN "downloadSource" = 'tidal' THEN 'soulseek'
        ELSE "downloadSource"
    END,
    "primaryFailureFallback" = CASE
        WHEN "primaryFailureFallback" = 'tidal' THEN 'none'
        ELSE "primaryFailureFallback"
    END,
    "playbackSourceOrder" = 'library,peers,ytmusic';

ALTER TABLE "UserSettings"
    ALTER COLUMN "showTidalExplore" SET DEFAULT false;

ALTER TABLE "SystemSettings"
    ALTER COLUMN "playbackSourceOrder" SET DEFAULT 'library,peers,ytmusic';
