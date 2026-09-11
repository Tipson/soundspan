CREATE TABLE "MusicSourceConnection" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MusicSourceConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MusicSourceConnection_provider_check" CHECK ("id" IN ('yandex', 'vk')),
    CONSTRAINT "MusicSourceConnection_version_check" CHECK ("version" > 0)
);
