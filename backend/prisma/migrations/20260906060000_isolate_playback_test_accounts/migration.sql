-- Additive: existing accounts remain ordinary users; no historical data changes.
ALTER TABLE "User" ADD COLUMN "isTestAccount" BOOLEAN NOT NULL DEFAULT false;
