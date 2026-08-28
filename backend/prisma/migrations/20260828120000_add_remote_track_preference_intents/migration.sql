CREATE TABLE "RemoteTrackPreferenceIntent" (
    "userId" TEXT NOT NULL,
    "remoteTrackId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemoteTrackPreferenceIntent_pkey" PRIMARY KEY ("userId", "remoteTrackId"),
    CONSTRAINT "RemoteTrackPreferenceIntent_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RemoteTrackPreferenceIntent_userId_idx"
ON "RemoteTrackPreferenceIntent"("userId");
