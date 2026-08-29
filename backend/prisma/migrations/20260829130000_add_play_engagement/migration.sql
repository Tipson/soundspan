-- Capture bounded playback outcomes so recommendations can distinguish a
-- completed listen from an early skip without changing existing play rows.
ALTER TABLE "Play"
    ADD COLUMN "listenedSeconds" DOUBLE PRECISION,
    ADD COLUMN "completionRatio" DOUBLE PRECISION,
    ADD COLUMN "outcome" TEXT,
    ADD COLUMN "playContext" TEXT,
    ADD COLUMN "waveMode" TEXT,
    ADD COLUMN "engagementUpdatedAt" TIMESTAMP(3);

ALTER TABLE "Play"
    ADD CONSTRAINT "Play_listenedSeconds_check"
        CHECK ("listenedSeconds" IS NULL OR "listenedSeconds" BETWEEN 0 AND 86400),
    ADD CONSTRAINT "Play_completionRatio_check"
        CHECK ("completionRatio" IS NULL OR "completionRatio" BETWEEN 0 AND 1),
    ADD CONSTRAINT "Play_outcome_check"
        CHECK ("outcome" IS NULL OR "outcome" IN ('meaningful', 'completed', 'skipped', 'failed')),
    ADD CONSTRAINT "Play_context_check"
        CHECK ("playContext" IS NULL OR "playContext" IN ('wave', 'home', 'search', 'playlist', 'album', 'artist', 'library')),
    ADD CONSTRAINT "Play_waveMode_check"
        CHECK ("waveMode" IS NULL OR "waveMode" IN ('for-you', 'new', 'familiar'));
