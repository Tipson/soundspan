-- Extend the existing import journal; legacy jobs retain their original flow.
ALTER TABLE "ImportJob"
    ADD COLUMN "draftData" JSONB,
    ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "confirmedSnapshot" JSONB,
    ADD COLUMN "draftResult" JSONB;

ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_draft_revision_check"
    CHECK (("draftData" IS NULL AND "draftRevision" = 0)
        OR ("draftData" IS NOT NULL AND "draftRevision" > 0));
