-- Keep initial taste selections isolated per account. The JSON payload stores
-- bounded provider metadata only; timestamps distinguish completion from skip.
ALTER TABLE "UserSettings"
    ADD COLUMN "tasteProfile" JSONB,
    ADD COLUMN "tasteProfileCompletedAt" TIMESTAMP(3),
    ADD COLUMN "tasteProfileSkippedAt" TIMESTAMP(3);

ALTER TABLE "UserSettings"
    ADD CONSTRAINT "UserSettings_tasteProfile_object_check"
        CHECK (
            "tasteProfile" IS NULL
            OR jsonb_typeof("tasteProfile") = 'object'
        ),
    ADD CONSTRAINT "UserSettings_tasteProfile_state_check"
        CHECK (
            NOT (
                "tasteProfileCompletedAt" IS NOT NULL
                AND "tasteProfileSkippedAt" IS NOT NULL
            )
            AND (
                "tasteProfileCompletedAt" IS NULL
                OR "tasteProfile" IS NOT NULL
            )
            AND (
                "tasteProfileSkippedAt" IS NULL
                OR "tasteProfile" IS NULL
            )
        );
