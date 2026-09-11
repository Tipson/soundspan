CREATE TABLE "TestApplication" (
    "id" TEXT NOT NULL,
    "telegram" TEXT NOT NULL,
    "device" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "inviteCodeId" TEXT,
    CONSTRAINT "TestApplication_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TestApplication_telegram_key" ON "TestApplication"("telegram");
CREATE UNIQUE INDEX "TestApplication_inviteCodeId_key" ON "TestApplication"("inviteCodeId");
CREATE INDEX "TestApplication_createdAt_id_idx" ON "TestApplication"("createdAt", "id");
ALTER TABLE "TestApplication" ADD CONSTRAINT "TestApplication_inviteCodeId_fkey"
    FOREIGN KEY ("inviteCodeId") REFERENCES "InviteCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
