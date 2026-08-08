-- F15: indexed pivot-sample column for GET /tracks/shuffle's large-library
-- branch, replacing a full-table `ORDER BY RANDOM()` scan+sort.
--
-- NOTE: `prisma migrate dev`'s auto-diff against this branch's schema.prisma
-- also proposed several unrelated statements (DROP INDEX on
-- track_embeddings' ivfflat index, default/nullability changes on Bookmark,
-- LibraryHealthRecord, SystemSettings, and Track.vibeAnalysis* columns).
-- Those reflect pre-existing drift between schema.prisma and the migration
-- history already present on this integration branch (dc2735e) — none of it
-- is caused by or in scope for this change (the track_embeddings index in
-- particular is an Unsupported()-column ivfflat index that Prisma's DSL
-- cannot represent, so its diff engine proposes dropping it any time
-- `migrate dev` runs here; that's pre-existing and not F15's concern). This
-- migration intentionally contains ONLY the F15 change.
--
-- Add the nullable column first so PostgreSQL can make the schema change
-- without rewriting Track under an ACCESS EXCLUSIVE lock. Install the default
-- before backfilling so concurrent inserts cannot create new NULL values.

-- AlterTable
ALTER TABLE "Track" ADD COLUMN "random" DOUBLE PRECISION;
ALTER TABLE "Track" ALTER COLUMN "random" SET DEFAULT random();

-- Backfill existing rows as ordinary writes instead of an ADD COLUMN rewrite.
UPDATE "Track" SET "random" = random() WHERE "random" IS NULL;

-- Validate nullability without holding the stronger validation lock during
-- SET NOT NULL, then remove the redundant check constraint.
ALTER TABLE "Track"
    ADD CONSTRAINT "Track_random_not_null" CHECK ("random" IS NOT NULL) NOT VALID;
ALTER TABLE "Track" VALIDATE CONSTRAINT "Track_random_not_null";
ALTER TABLE "Track" ALTER COLUMN "random" SET NOT NULL;
ALTER TABLE "Track" DROP CONSTRAINT "Track_random_not_null";

-- CreateIndex (CONCURRENTLY cannot run inside a transaction block, so this
-- migration must remain free of explicit BEGIN/COMMIT statements.)
CREATE INDEX CONCURRENTLY "Track_random_idx" ON "Track"("random");
