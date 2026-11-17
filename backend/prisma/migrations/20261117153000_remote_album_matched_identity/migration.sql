ALTER TABLE "Album"
ADD COLUMN "matchedRgMbid" TEXT,
ADD COLUMN "rgMbidCheckedAt" TIMESTAMP(3),
ADD COLUMN "rgMbidMatchInputHash" TEXT;
