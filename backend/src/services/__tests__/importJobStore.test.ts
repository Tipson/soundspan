describe("import job store", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupImportJobStoreMocks() {
        const prisma: any = {
            importJob: {
                create: jest.fn(async ({ data }) => ({
                    id: "import-job-1",
                    createdAt: new Date("2026-03-14T18:30:00.000Z"),
                    updatedAt: new Date("2026-03-14T18:30:00.000Z"),
                    ...data,
                })),
                update: jest.fn(async ({ where, data }) => ({
                    id: where.id,
                    userId: "user-1",
                    sourceType: "spotify",
                    sourceId: "37i9dQZF1DX4JAvHpjipBk",
                    sourceUrl:
                        "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk",
                    normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
                    playlistName: "Weekend Mix",
                    requestedPlaylistName: null,
                    status: "resolving",
                    progress: 45,
                    summary: null,
                    resolvedTracks: null,
                    createdPlaylistId: null,
                    error: null,
                    createdAt: new Date("2026-03-14T18:30:00.000Z"),
                    updatedAt: new Date("2026-03-14T18:31:00.000Z"),
                    ...data,
                })),
                findUnique: jest.fn(async () => null),
                findFirst: jest.fn(async () => null),
                findMany: jest.fn(async () => []),
                updateMany: jest.fn(async () => ({ count: 0 })),
            },
            playlist: {
                findUnique: jest.fn(async () => null),
            },
        };
        let transactionTail = Promise.resolve();
        prisma.$transaction = jest.fn(
            async (operation: (client: typeof prisma) => Promise<unknown>) => {
                const result = transactionTail.then(() => operation(prisma));
                transactionTail = result.then(
                    () => undefined,
                    () => undefined,
                );
                return result;
            },
        );

        jest.doMock("../../utils/db", () => ({ prisma }));

        return { prisma };
    }

    it("normalizes source URLs and persists a created generic import job", async () => {
        const { prisma } = setupImportJobStoreMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");

        const job = await importJobStore.createJob({
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "37i9dQZF1DX4JAvHpjipBk",
            sourceUrl:
                "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk?si=abc123",
            playlistName: "Weekend Mix",
            requestedPlaylistName: "Roadtrip Weekend",
            status: "pending",
            progress: 0,
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        expect(prisma.importJob.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: "user-1",
                sourceType: "spotify",
                sourceId: "37i9dQZF1DX4JAvHpjipBk",
                sourceUrl:
                    "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk?si=abc123",
                normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
                playlistName: "Weekend Mix",
                requestedPlaylistName: "Roadtrip Weekend",
                status: "pending",
                progress: 0,
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
                createdPlaylistId: null,
                error: null,
            }),
        });
        expect(job.normalizedSource).toBe("spotify:37i9dQZF1DX4JAvHpjipBk");
    });

    it("atomically deduplicates concurrent claims for the same user and source", async () => {
        const { prisma } = setupImportJobStoreMocks();
        const persistedJobs: any[] = [];
        (prisma.importJob.findFirst as jest.Mock).mockImplementation(
            async ({ where }) =>
                persistedJobs.find(
                    (job) =>
                        job.userId === where.userId &&
                        job.normalizedSource === where.normalizedSource &&
                        where.status.in.includes(job.status),
                ) ?? null,
        );
        (prisma.importJob.create as jest.Mock).mockImplementation(
            async ({ data }) => {
                const created = {
                    id: `import-job-${persistedJobs.length + 1}`,
                    createdAt: new Date("2026-03-14T18:30:00.000Z"),
                    updatedAt: new Date("2026-03-14T18:30:00.000Z"),
                    resolvedTracks: null,
                    ...data,
                };
                persistedJobs.push(created);
                return created;
            },
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const input = {
            userId: "user-1",
            sourceType: "Spotify",
            sourceId: "37i9dQZF1DX4JAvHpjipBk",
            sourceUrl:
                "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk",
            playlistName: "Spotify import",
            status: "pending" as const,
            progress: 0,
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        };

        const [first, second] = await Promise.all([
            importJobStore.claimJob(input),
            importJobStore.claimJob(input),
        ]);

        expect([first.created, second.created]).toEqual([true, false]);
        expect(first.job.id).toBe(second.job.id);
        expect(prisma.importJob.create).toHaveBeenCalledTimes(1);
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.$transaction).toHaveBeenNthCalledWith(
            1,
            expect.any(Function),
            { isolationLevel: "Serializable" },
        );
    });

    it("retries a serializable claim after a PostgreSQL transaction conflict", async () => {
        const { prisma } = setupImportJobStoreMocks();
        const transactionImplementation =
            prisma.$transaction.getMockImplementation();
        prisma.$transaction
            .mockRejectedValueOnce(
                Object.assign(new Error("write conflict"), { code: "P2034" }),
            )
            .mockImplementation(transactionImplementation);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const result = await importJobStore.claimJob({
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-1",
            sourceUrl: "https://open.spotify.com/playlist/playlist-1",
            playlistName: "Spotify import",
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        expect(result.created).toBe(true);
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.importJob.create).toHaveBeenCalledTimes(1);
    });

    it("reconciles a failed committed import on API resubmit without creating a new job", async () => {
        const { prisma } = setupImportJobStoreMocks();
        const failedJob = {
            id: "failed-committed-job",
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-1",
            sourceUrl: "https://open.spotify.com/playlist/playlist-1",
            normalizedSource: "spotify:playlist-1",
            playlistName: "Committed import",
            requestedPlaylistName: null,
            status: "failed",
            progress: 100,
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            resolvedTracks: [],
            createdPlaylistId: null,
            error: "Generic import job failed",
            createdAt: new Date("2026-03-14T18:30:00.000Z"),
            updatedAt: new Date("2026-03-14T18:31:00.000Z"),
        };
        (prisma.importJob.findMany as jest.Mock).mockResolvedValueOnce([
            failedJob,
        ]);
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "already-committed-playlist",
        });
        (prisma.importJob.updateMany as jest.Mock).mockImplementationOnce(
            async ({ where, data }) => {
                if (where.id === failedJob.id && where.status === "failed") {
                    Object.assign(failedJob, data);
                    return { count: 1 };
                }
                return { count: 0 };
            },
        );
        (prisma.importJob.findUnique as jest.Mock).mockImplementation(
            async ({ where }) => (where.id === failedJob.id ? failedJob : null),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const claim = await importJobStore.claimJob({
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-1",
            sourceUrl: "https://open.spotify.com/playlist/playlist-1",
            playlistName: "Spotify import",
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        expect(claim.created).toBe(false);
        expect(claim.job).toEqual(
            expect.objectContaining({
                id: failedJob.id,
                status: "completed",
                progress: 100,
                createdPlaylistId: "already-committed-playlist",
                error: "Playlist creation completed; recovered import status after a persistence failure",
            }),
        );
        expect(prisma.importJob.create).not.toHaveBeenCalled();
        expect(prisma.importJob.findMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                normalizedSource: "spotify:playlist-1",
                status: {
                    in: ["failed", "completed", "cancelled"],
                },
            },
            orderBy: { updatedAt: "desc" },
            take: 1,
        });
        expect(prisma.playlist.findUnique).toHaveBeenCalledWith({
            where: {
                userId_mixId: {
                    userId: "user-1",
                    mixId: "generic-import-job:failed-committed-job",
                },
            },
            select: { id: true },
        });
    });

    it("returns the concurrent reconciliation winner instead of creating a resubmit job", async () => {
        const { prisma } = setupImportJobStoreMocks();
        const failedJob = {
            id: "failed-concurrent-reconcile",
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-race",
            sourceUrl: "https://open.spotify.com/playlist/playlist-race",
            normalizedSource: "spotify:playlist-race",
            playlistName: "Committed race import",
            requestedPlaylistName: null,
            status: "failed",
            progress: 100,
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            resolvedTracks: [],
            createdPlaylistId: null as string | null,
            error: "Generic import job failed" as string | null,
            createdAt: new Date("2026-03-14T18:30:00.000Z"),
            updatedAt: new Date("2026-03-14T18:31:00.000Z"),
        };
        (prisma.importJob.findMany as jest.Mock)
            .mockResolvedValueOnce([failedJob])
            .mockResolvedValue([failedJob]);
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            id: "concurrent-winner-playlist",
        });
        (prisma.importJob.updateMany as jest.Mock).mockImplementationOnce(
            async () => {
                failedJob.status = "completed";
                failedJob.createdPlaylistId = "concurrent-winner-playlist";
                failedJob.error =
                    "Playlist creation completed; recovered import status after a persistence failure";
                failedJob.updatedAt = new Date();
                return { count: 0 };
            },
        );
        (prisma.importJob.findUnique as jest.Mock).mockImplementation(
            async ({ where }) => (where.id === failedJob.id ? failedJob : null),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const claim = await importJobStore.claimJob({
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-race",
            sourceUrl: "https://open.spotify.com/playlist/playlist-race",
            playlistName: "Spotify import",
            summary: failedJob.summary,
        });

        expect(claim).toEqual({
            created: false,
            job: expect.objectContaining({
                id: failedJob.id,
                status: "completed",
                createdPlaylistId: "concurrent-winner-playlist",
            }),
        });
        expect(prisma.importJob.create).not.toHaveBeenCalled();
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it("deduplicates two independent resubmits after the first reconciles a committed failure", async () => {
        const { prisma } = setupImportJobStoreMocks();
        const failedJob = {
            id: "failed-two-resubmits",
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-two-resubmits",
            sourceUrl:
                "https://open.spotify.com/playlist/playlist-two-resubmits",
            normalizedSource: "spotify:playlist-two-resubmits",
            playlistName: "Committed two-resubmit import",
            requestedPlaylistName: null,
            status: "failed",
            progress: 100,
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            resolvedTracks: [],
            createdPlaylistId: null as string | null,
            error: "Generic import job failed" as string | null,
            createdAt: new Date("2026-03-14T18:30:00.000Z"),
            updatedAt: new Date("2026-03-14T18:31:00.000Z"),
        };
        const persistedJobs: Array<typeof failedJob> = [failedJob];
        (prisma.importJob.findFirst as jest.Mock).mockImplementation(
            async ({ where }) =>
                persistedJobs.find(
                    (job) =>
                        job.userId === where.userId &&
                        job.normalizedSource === where.normalizedSource &&
                        where.status.in.includes(job.status),
                ) ?? null,
        );
        (prisma.importJob.findMany as jest.Mock).mockImplementation(
            async ({ where }) =>
                persistedJobs.filter((job) => {
                    if (
                        job.userId !== where.userId ||
                        job.normalizedSource !== where.normalizedSource
                    ) {
                        return false;
                    }
                    return where.status.in.includes(job.status);
                }),
        );
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValue({
            id: "playlist-two-resubmits",
        });
        (prisma.importJob.updateMany as jest.Mock).mockImplementation(
            async ({ where, data }) => {
                if (
                    where.id === failedJob.id &&
                    where.userId === failedJob.userId &&
                    where.status === failedJob.status
                ) {
                    Object.assign(failedJob, data, {
                        updatedAt: new Date(),
                    });
                    return { count: 1 };
                }
                return { count: 0 };
            },
        );
        (prisma.importJob.findUnique as jest.Mock).mockImplementation(
            async ({ where }) =>
                persistedJobs.find((job) => job.id === where.id) ?? null,
        );
        (prisma.importJob.create as jest.Mock).mockImplementation(
            async ({ data }) => {
                const created = {
                    ...failedJob,
                    ...data,
                    id: "duplicate-resubmit-job",
                };
                persistedJobs.push(created);
                return created;
            },
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const input = {
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-two-resubmits",
            sourceUrl:
                "https://open.spotify.com/playlist/playlist-two-resubmits",
            playlistName: "Spotify import",
            summary: failedJob.summary,
        };

        const [first, second] = await Promise.all([
            importJobStore.claimJob(input),
            importJobStore.claimJob(input),
        ]);

        expect(first).toEqual({
            created: false,
            job: expect.objectContaining({
                id: failedJob.id,
                status: "completed",
                createdPlaylistId: "playlist-two-resubmits",
            }),
        });
        expect(second).toEqual({
            created: false,
            job: expect.objectContaining({
                id: failedJob.id,
                status: "completed",
                createdPlaylistId: "playlist-two-resubmits",
            }),
        });
        expect(prisma.importJob.create).not.toHaveBeenCalled();
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(failedJob.error).toBe(
            "Playlist creation completed; recovered import status after a persistence failure",
        );
    });

    it("allows a deliberate reimport after the recovered-commit dedupe window expires", async () => {
        const { prisma } = setupImportJobStoreMocks();
        const recoveredJob = {
            id: "recovered-expired-job",
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-recovered-expired",
            sourceUrl:
                "https://open.spotify.com/playlist/playlist-recovered-expired",
            normalizedSource: "spotify:playlist-recovered-expired",
            playlistName: "Recovered import",
            requestedPlaylistName: null,
            status: "completed",
            progress: 100,
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            resolvedTracks: [],
            createdPlaylistId: "recovered-expired-playlist",
            error: "Playlist creation completed; recovered import status after a persistence failure",
            createdAt: new Date(Date.now() - 11 * 60_000),
            updatedAt: new Date(Date.now() - 10 * 60_000),
        };
        (prisma.importJob.findMany as jest.Mock).mockResolvedValueOnce([
            recoveredJob,
        ]);
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValueOnce({
            id: recoveredJob.createdPlaylistId,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const claim = await importJobStore.claimJob({
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-recovered-expired",
            sourceUrl:
                "https://open.spotify.com/playlist/playlist-recovered-expired",
            playlistName: "Spotify import",
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        expect(claim.created).toBe(true);
        expect(claim.job.id).toBe("import-job-1");
        expect(prisma.importJob.create).toHaveBeenCalledTimes(1);
        expect(prisma.playlist.findUnique).not.toHaveBeenCalled();
    });

    it("keeps ordinary completed-source reimports available", async () => {
        const { prisma } = setupImportJobStoreMocks();
        (prisma.importJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "ordinary-completed-job",
                userId: "user-1",
                sourceType: "spotify",
                sourceId: "playlist-completed",
                sourceUrl:
                    "https://open.spotify.com/playlist/playlist-completed",
                normalizedSource: "spotify:playlist-completed",
                playlistName: "Earlier successful import",
                requestedPlaylistName: null,
                status: "completed",
                progress: 100,
                summary: {
                    total: 1,
                    local: 1,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
                resolvedTracks: [],
                createdPlaylistId: "ordinary-completed-playlist",
                error: null,
                createdAt: new Date("2026-03-14T18:30:00.000Z"),
                updatedAt: new Date("2026-03-14T18:31:00.000Z"),
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const claim = await importJobStore.claimJob({
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-completed",
            sourceUrl: "https://open.spotify.com/playlist/playlist-completed",
            playlistName: "Spotify import",
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        expect(claim.created).toBe(true);
        expect(prisma.importJob.create).toHaveBeenCalledTimes(1);
        expect(prisma.playlist.findUnique).not.toHaveBeenCalled();
    });

    it("creates a retry job when a failed import has no committed playlist marker", async () => {
        const { prisma } = setupImportJobStoreMocks();
        (prisma.importJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "failed-before-commit",
                userId: "user-1",
                normalizedSource: "spotify:playlist-missing",
                status: "failed",
                updatedAt: new Date("2026-03-14T18:31:00.000Z"),
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const claim = await importJobStore.claimJob({
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-missing",
            sourceUrl: "https://open.spotify.com/playlist/playlist-missing",
            playlistName: "Spotify import",
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        expect(claim.created).toBe(true);
        expect(prisma.importJob.create).toHaveBeenCalledTimes(1);
        expect(prisma.playlist.findUnique).toHaveBeenCalledWith({
            where: {
                userId_mixId: {
                    userId: "user-1",
                    mixId: "generic-import-job:failed-before-commit",
                },
            },
            select: { id: true },
        });
        expect(prisma.importJob.findMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                normalizedSource: "spotify:playlist-missing",
                status: {
                    in: ["failed", "completed", "cancelled"],
                },
            },
            orderBy: { updatedAt: "desc" },
            take: 1,
        });
        expect(prisma.importJob.updateMany).not.toHaveBeenCalled();
    });

    it("keeps claim ownership isolated across users and normalized sources", async () => {
        const { prisma } = setupImportJobStoreMocks();
        const persistedJobs: any[] = [];
        (prisma.importJob.findFirst as jest.Mock).mockImplementation(
            async ({ where }) =>
                persistedJobs.find(
                    (job) =>
                        job.userId === where.userId &&
                        job.normalizedSource === where.normalizedSource &&
                        where.status.in.includes(job.status),
                ) ?? null,
        );
        (prisma.importJob.create as jest.Mock).mockImplementation(
            async ({ data }) => {
                const created = {
                    id: `isolated-job-${persistedJobs.length + 1}`,
                    createdAt: new Date("2026-03-14T18:30:00.000Z"),
                    updatedAt: new Date("2026-03-14T18:30:00.000Z"),
                    resolvedTracks: null,
                    ...data,
                };
                persistedJobs.push(created);
                return created;
            },
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const baseInput = {
            sourceType: "spotify",
            sourceUrl: "https://open.spotify.com/playlist/playlist-1",
            playlistName: "Spotify import",
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        };

        const claims = await Promise.all([
            importJobStore.claimJob({
                ...baseInput,
                userId: "user-1",
                sourceId: "playlist-1",
            }),
            importJobStore.claimJob({
                ...baseInput,
                userId: "user-2",
                sourceId: "playlist-1",
            }),
            importJobStore.claimJob({
                ...baseInput,
                userId: "user-1",
                sourceId: "playlist-2",
                sourceUrl: "https://open.spotify.com/playlist/playlist-2",
            }),
        ]);

        expect(claims.map((claim) => claim.created)).toEqual([
            true,
            true,
            true,
        ]);
        expect(new Set(claims.map((claim) => claim.job.id)).size).toBe(3);
        expect(prisma.importJob.create).toHaveBeenCalledTimes(3);
    });

    it("updates lifecycle state, progress, summary, and result linkage", async () => {
        const { prisma } = setupImportJobStoreMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");

        const job = await importJobStore.updateJob("import-job-1", {
            status: "completed",
            progress: 100,
            playlistName: "Resolved Weekend Mix",
            summary: {
                total: 12,
                local: 6,
                youtube: 3,
                tidal: 2,
                unresolved: 1,
            },
            createdPlaylistId: "playlist-123",
        });

        expect(prisma.importJob.update).toHaveBeenCalledWith({
            where: { id: "import-job-1" },
            data: {
                status: "completed",
                progress: 100,
                playlistName: "Resolved Weekend Mix",
                summary: {
                    total: 12,
                    local: 6,
                    youtube: 3,
                    tidal: 2,
                    unresolved: 1,
                },
                createdPlaylistId: "playlist-123",
            },
        });
        expect(job.status).toBe("completed");
        expect(job.createdPlaylistId).toBe("playlist-123");
    });

    it("conditionally requests cancellation while a job is still active", async () => {
        const { prisma } = setupImportJobStoreMocks();
        (prisma.importJob.updateMany as jest.Mock).mockResolvedValueOnce({
            count: 1,
        });
        (prisma.importJob.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "job-1",
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-1",
            sourceUrl: "https://open.spotify.com/playlist/playlist-1",
            normalizedSource: "spotify:playlist-1",
            playlistName: "Spotify import",
            requestedPlaylistName: null,
            status: "cancelling",
            progress: 70,
            summary: {},
            resolvedTracks: null,
            createdPlaylistId: null,
            error: "Cancelled by user",
            createdAt: new Date("2026-03-14T18:30:00.000Z"),
            updatedAt: new Date("2026-03-14T18:31:00.000Z"),
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const result = await importJobStore.requestCancellation(
            "job-1",
            "user-1",
        );

        expect(result.outcome).toBe("updated");
        expect(result.job?.status).toBe("cancelling");
        expect(prisma.importJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: "job-1",
                userId: "user-1",
                status: {
                    in: [
                        "pending",
                        "resolving",
                        "creating_playlist",
                        "cancelling",
                    ],
                },
            },
            data: {
                status: "cancelling",
                error: "Cancelled by user",
            },
        });
    });

    it("reports a conflict when completion wins the cancellation race", async () => {
        const { prisma } = setupImportJobStoreMocks();
        (prisma.importJob.updateMany as jest.Mock).mockResolvedValueOnce({
            count: 0,
        });
        (prisma.importJob.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "job-1",
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-1",
            sourceUrl: "https://open.spotify.com/playlist/playlist-1",
            normalizedSource: "spotify:playlist-1",
            playlistName: "Spotify import",
            requestedPlaylistName: null,
            status: "completed",
            progress: 100,
            summary: {},
            resolvedTracks: [],
            createdPlaylistId: "playlist-created",
            error: null,
            createdAt: new Date("2026-03-14T18:30:00.000Z"),
            updatedAt: new Date("2026-03-14T18:31:00.000Z"),
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const result = await importJobStore.requestCancellation(
            "job-1",
            "user-1",
        );

        expect(result).toEqual({
            outcome: "conflict",
            job: expect.objectContaining({
                id: "job-1",
                status: "completed",
            }),
        });
        expect(prisma.importJob.update).not.toHaveBeenCalled();
    });

    it("conditionally transitions a job from one expected lifecycle state", async () => {
        const { prisma } = setupImportJobStoreMocks();
        const persistedJob = {
            id: "job-transition",
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "playlist-1",
            sourceUrl: "https://open.spotify.com/playlist/playlist-1",
            normalizedSource: "spotify:playlist-1",
            playlistName: "Spotify import",
            requestedPlaylistName: null,
            status: "resolving",
            progress: 20,
            summary: {},
            resolvedTracks: null,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-03-14T18:30:00.000Z"),
            updatedAt: new Date("2026-03-14T18:31:00.000Z"),
        };
        (prisma.importJob.updateMany as jest.Mock).mockImplementation(
            async ({ where, data }) => {
                if (
                    where.id !== persistedJob.id ||
                    !where.status.in.includes(persistedJob.status)
                ) {
                    return { count: 0 };
                }
                Object.assign(persistedJob, data);
                return { count: 1 };
            },
        );
        (prisma.importJob.findUnique as jest.Mock).mockImplementation(
            async () => persistedJob,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const transitioned = await importJobStore.transitionJob(
            "job-transition",
            ["pending", "resolving"],
            {
                status: "creating_playlist",
                progress: 70,
            },
        );

        expect(transitioned).toEqual(
            expect.objectContaining({
                id: "job-transition",
                status: "creating_playlist",
                progress: 70,
            }),
        );
        expect(prisma.importJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: "job-transition",
                status: { in: ["pending", "resolving"] },
            },
            data: {
                status: "creating_playlist",
                progress: 70,
            },
        });
    });

    it.each(["completed", "cancelling"])(
        "does not overwrite a %s job outside the expected transition states",
        async (currentStatus) => {
            const { prisma } = setupImportJobStoreMocks();
            const persistedJob = {
                id: `job-${currentStatus}`,
                status: currentStatus,
                progress: currentStatus === "completed" ? 100 : 70,
            };
            (prisma.importJob.updateMany as jest.Mock).mockImplementation(
                async ({ where, data }) => {
                    if (!where.status.in.includes(persistedJob.status)) {
                        return { count: 0 };
                    }
                    Object.assign(persistedJob, data);
                    return { count: 1 };
                },
            );

            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { importJobStore } = require("../importJobStore");
            const transitioned = await importJobStore.transitionJob(
                persistedJob.id,
                ["pending", "resolving", "creating_playlist"],
                { status: "failed", progress: 100 },
            );

            expect(transitioned).toBeNull();
            expect(persistedJob.status).toBe(currentStatus);
            expect(prisma.importJob.findUnique).not.toHaveBeenCalled();
        },
    );

    it("finds an existing active job for a normalized source and excludes terminal states", async () => {
        const { prisma } = setupImportJobStoreMocks();
        (prisma.importJob.findFirst as jest.Mock)
            .mockResolvedValueOnce({
                id: "job-active",
                userId: "user-1",
                sourceType: "spotify",
                sourceId: "37i9dQZF1DX4JAvHpjipBk",
                sourceUrl:
                    "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk",
                normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
                playlistName: "Weekend Mix",
                requestedPlaylistName: null,
                status: "resolving",
                progress: 35,
                summary: null,
                resolvedTracks: null,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-03-14T18:30:00.000Z"),
                updatedAt: new Date("2026-03-14T18:31:00.000Z"),
            })
            .mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");

        const active = await importJobStore.findActiveJobForSource(
            "user-1",
            "spotify:37i9dQZF1DX4JAvHpjipBk",
        );
        const terminal = await importJobStore.findActiveJobForSource(
            "user-1",
            "spotify:completed-playlist",
        );

        expect(prisma.importJob.findFirst).toHaveBeenNthCalledWith(1, {
            where: {
                userId: "user-1",
                normalizedSource: "spotify:37i9dQZF1DX4JAvHpjipBk",
                status: {
                    in: [
                        "pending",
                        "resolving",
                        "creating_playlist",
                        "cancelling",
                    ],
                },
            },
            orderBy: {
                updatedAt: "desc",
            },
        });
        expect(active?.id).toBe("job-active");
        expect(terminal).toBeNull();
    });

    it("lists a user's jobs in newest-first order", async () => {
        const { prisma } = setupImportJobStoreMocks();
        (prisma.importJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-2",
                userId: "user-1",
                sourceType: "deezer",
                sourceId: "123",
                sourceUrl: "https://deezer.com/playlist/123",
                normalizedSource: "deezer:123",
                playlistName: "Second",
                requestedPlaylistName: null,
                status: "failed",
                progress: 10,
                summary: null,
                resolvedTracks: null,
                createdPlaylistId: null,
                error: "boom",
                createdAt: new Date("2026-03-14T18:40:00.000Z"),
                updatedAt: new Date("2026-03-14T18:41:00.000Z"),
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");

        const jobs = await importJobStore.listJobsForUser("user-1");

        expect(prisma.importJob.findMany).toHaveBeenCalledWith({
            where: { userId: "user-1" },
            orderBy: { updatedAt: "desc" },
            take: 25,
        });
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.normalizedSource).toBe("deezer:123");
    });

    it("reopens an owned failed import when its visible playlist has unresolved positions", async () => {
        const { prisma } = setupImportJobStoreMocks();
        const persistedJob = {
            id: "job-retry",
            userId: "user-1",
            sourceType: "spotify",
            sourceId: "source-1",
            sourceUrl: "https://open.spotify.com/playlist/source-1",
            normalizedSource: "spotify:source-1",
            playlistName: "Retry Mix",
            requestedPlaylistName: null,
            status: "failed",
            progress: 100,
            summary: {
                total: 10,
                local: 0,
                youtube: 8,
                tidal: 0,
                unresolved: 2,
            },
            resolvedTracks: [
                {
                    index: 9,
                    artist: "Artist",
                    title: "Missing",
                    source: "unresolved",
                    confidence: 0,
                },
            ],
            createdPlaylistId: "playlist-1",
            resolutionStartedAt: new Date("2026-03-14T18:30:00.000Z"),
            resolutionProcessed: 10,
            resolutionAttempt: 1,
            error: null,
            createdAt: new Date("2026-03-14T18:30:00.000Z"),
            updatedAt: new Date("2026-03-14T18:31:00.000Z"),
        };
        (prisma.importJob.findUnique as jest.Mock).mockResolvedValue(
            persistedJob,
        );
        (prisma.importJob.updateMany as jest.Mock).mockImplementation(
            async ({ data }) => {
                Object.assign(persistedJob, {
                    ...data,
                    resolutionAttempt:
                        persistedJob.resolutionAttempt +
                        (data.resolutionAttempt?.increment ?? 0),
                });
                return { count: 1 };
            },
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { importJobStore } = require("../importJobStore");
        const result = await importJobStore.requestResolutionRetry(
            "job-retry",
            "user-1",
        );

        expect(result.outcome).toBe("updated");
        expect(result.job).toEqual(
            expect.objectContaining({
                status: "resolving",
                progress: 40,
                resolutionProcessed: 8,
                resolutionAttempt: 2,
            }),
        );
        expect(prisma.importJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: "job-retry",
                userId: "user-1",
                status: { in: ["completed", "cancelled", "failed"] },
                createdPlaylistId: { not: null },
            },
            data: expect.objectContaining({
                status: "resolving",
                progress: 40,
                resolutionProcessed: 8,
                resolutionAttempt: { increment: 1 },
                resolutionStartedAt: null,
                error: null,
            }),
        });
    });
});
