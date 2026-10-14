ALTER TABLE "PlaybackState"
    ADD COLUMN "revision" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    ADD COLUMN "isCleared" BOOLEAN NOT NULL DEFAULT false;

CREATE FUNCTION "refreshPlaybackStateRevision"() RETURNS trigger AS $$
BEGIN
    NEW."revision" := gen_random_uuid()::text;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PlaybackState_revision_trigger"
    BEFORE UPDATE ON "PlaybackState"
    FOR EACH ROW EXECUTE FUNCTION "refreshPlaybackStateRevision"();
