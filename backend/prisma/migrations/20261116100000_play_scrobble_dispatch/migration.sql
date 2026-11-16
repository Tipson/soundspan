-- Additive destination fence; old connection writers remain compatible while keyed producer is off.
BEGIN;
ALTER TABLE "ScrobbleConnection" ADD COLUMN "authEpoch" INTEGER NOT NULL DEFAULT 0;
CREATE TYPE "PlayScrobbleDispatchState" AS ENUM ('PENDING','CLAIMED','SUBMITTED','REJECTED','INVALID_AUTH','AMBIGUOUS','FAILED_NOT_SENT','NO_TARGET','CANCELLED');
CREATE TABLE "PlayScrobbleDispatch" (
 "id" TEXT NOT NULL,
 "userId" TEXT NOT NULL,
 "playId" TEXT,
 "connectionId" TEXT,
 "authEpoch" INTEGER NOT NULL,
 "userTokenVersion" INTEGER NOT NULL,
 "service" TEXT NOT NULL,
 "listenedAt" TIMESTAMP(3) NOT NULL,
 "metadata" JSONB,
 "state" "PlayScrobbleDispatchState" NOT NULL DEFAULT 'PENDING',
 "reason" TEXT,
 "attemptCount" INTEGER NOT NULL DEFAULT 0,
 "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "claimedAt" TIMESTAMP(3),
 "claimExpiresAt" TIMESTAMP(3),
 "claimToken" TEXT,
 "completedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expiresAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "PlayScrobbleDispatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlayScrobbleDispatch_playId_service_key" ON "PlayScrobbleDispatch"("playId","service");
CREATE INDEX "PlayScrobbleDispatch_userId_state_idx" ON "PlayScrobbleDispatch"("userId","state");
CREATE INDEX "PlayScrobbleDispatch_connectionId_authEpoch_state_idx" ON "PlayScrobbleDispatch"("connectionId","authEpoch","state");
CREATE INDEX "PlayScrobbleDispatch_state_availableAt_id_idx" ON "PlayScrobbleDispatch"("state","availableAt","id");
CREATE INDEX "PlayScrobbleDispatch_state_claimExpiresAt_idx" ON "PlayScrobbleDispatch"("state","claimExpiresAt");
CREATE INDEX "PlayScrobbleDispatch_expiresAt_idx" ON "PlayScrobbleDispatch"("expiresAt");
CREATE INDEX "PlayCreationReceipt_expiresAt_userId_idx" ON "PlayCreationReceipt"("expiresAt","userId");
ALTER TABLE "PlayScrobbleDispatch" ADD CONSTRAINT "PlayScrobbleDispatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlayScrobbleDispatch" ADD CONSTRAINT "PlayScrobbleDispatch_playId_fkey" FOREIGN KEY ("playId") REFERENCES "Play"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PlayScrobbleDispatch" ADD CONSTRAINT "PlayScrobbleDispatch_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ScrobbleConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;
