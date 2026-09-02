jest.mock("../../utils/logger", () => ({
    logger: (() => {
        const scopedLogger = {
            child: jest.fn(),
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        scopedLogger.child.mockReturnValue(scopedLogger);
        return scopedLogger;
    })(),
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        importJob: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../../workers/queues", () => ({
    genericImportQueue: {
        add: jest.fn(),
        getJob: jest.fn(),
        isReady: jest.fn(),
    },
}));

jest.mock("../importJobStore", () => ({
    importJobStore: {
        getJob: jest.fn(),
        transitionJob: jest.fn(),
    },
}));

jest.mock("../playlistImportService", () => ({
    playlistImportService: {
        previewImport: jest.fn(),
        importPlaylist: jest.fn(),
        findImportedPlaylistId: jest.fn(),
    },
}));

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { genericImportQueue } from "../../workers/queues";
import { importJobStore } from "../importJobStore";
import { playlistImportService } from "../playlistImportService";
import { genericImportJobRunner } from "../genericImportJobRunner";
import { SpotifyPlaylistPaginationError } from "../spotifyPlaylistPagination";

describe("generic import job runner", () => {
    const mockGetJob = importJobStore.getJob as jest.Mock;
    const mockTransitionJob = importJobStore.transitionJob as jest.Mock;
    const mockPreviewImport = playlistImportService.previewImport as jest.Mock;
    const mockImportPlaylist =
        playlistImportService.importPlaylist as jest.Mock;
    const mockFindImportedPlaylistId =
        playlistImportService.findImportedPlaylistId as jest.Mock;
    const mockQueueAdd = genericImportQueue.add as jest.Mock;
    const mockQueueGetJob = genericImportQueue.getJob as jest.Mock;
    const mockQueueReady = genericImportQueue.isReady as jest.Mock;
    const mockFindMany = prisma.importJob.findMany as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetJob.mockReset();
        mockTransitionJob.mockReset();
        mockPreviewImport.mockReset();
        mockImportPlaylist.mockReset();
        mockFindImportedPlaylistId.mockReset();
        mockQueueAdd.mockReset();
        mockQueueGetJob.mockReset();
        mockQueueReady.mockReset();
        mockFindMany.mockReset();
        mockQueueAdd.mockResolvedValue({ id: "queued-job" });
        mockQueueGetJob.mockResolvedValue(null);
        mockQueueReady.mockResolvedValue(undefined);
        mockFindMany.mockResolvedValue([]);
        mockFindImportedPlaylistId.mockResolvedValue(null);
        mockTransitionJob.mockImplementation(
            async (
                jobId: string,
                _expectedStatuses: string[],
                update: Record<string, unknown>,
            ) => ({
                id: jobId,
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                playlistName: "Spotify import",
                status: "pending",
                progress: 0,
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
                resolvedTracks: null,
                createdPlaylistId: null,
                error: null,
                ...update,
            }),
        );
    });

    function installStatefulJob<T extends { id: string; status: string }>(
        initialJob: T,
    ): T {
        const persistedJob = { ...initialJob };
        mockGetJob.mockImplementation(async () => ({ ...persistedJob }));
        mockTransitionJob.mockImplementation(
            async (
                _jobId: string,
                expectedStatuses: string[],
                update: Record<string, unknown>,
            ) => {
                if (!expectedStatuses.includes(persistedJob.status)) {
                    return null;
                }
                Object.assign(persistedJob, update);
                return { ...persistedJob };
            },
        );
        return persistedJob;
    }

    function createDeferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        return { promise, resolve, reject };
    }

    it("durably enqueues a persisted job with a stable queue identity", async () => {
        genericImportJobRunner.enqueue("job-durable");
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(mockQueueAdd).toHaveBeenCalledWith(
            "generic-import-run",
            { jobId: "job-durable" },
            { jobId: "job-durable" },
        );
    });

    it("coalesces duplicate submissions onto the existing durable queue job", async () => {
        mockQueueGetJob.mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue("waiting"),
        });

        genericImportJobRunner.enqueue("job-already-queued");
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(mockQueueAdd).not.toHaveBeenCalled();
        expect(mockTransitionJob).not.toHaveBeenCalled();
    });

    it("logs queue persistence failures without leaking an unhandled rejection", async () => {
        const queueError = new Error("redis credentials rejected");
        mockQueueAdd.mockRejectedValueOnce(queueError);

        genericImportJobRunner.enqueue("job-queue-failure");
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(logger.error).toHaveBeenCalledWith(
            "Failed to enqueue persisted import job",
            expect.objectContaining({
                jobId: "job-queue-failure",
                error: queueError,
            }),
        );
    });

    it("requeues a bounded batch of active persisted jobs for recovery", async () => {
        mockFindMany.mockResolvedValueOnce([
            { id: "pending-job" },
            { id: "resolving-job" },
            { id: "creating-job" },
            { id: "cancelling-job" },
        ]);

        await expect(genericImportJobRunner.recoverActiveJobs()).resolves.toBe(
            4,
        );

        expect(mockFindMany).toHaveBeenCalledWith({
            where: {
                status: {
                    in: [
                        "pending",
                        "resolving",
                        "creating_playlist",
                        "cancelling",
                    ],
                },
            },
            orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
            select: { id: true },
            take: 100,
        });
        expect(mockQueueAdd).toHaveBeenCalledTimes(4);
        expect(mockQueueAdd).toHaveBeenNthCalledWith(
            4,
            "generic-import-run",
            { jobId: "cancelling-job" },
            { jobId: "cancelling-job" },
        );
    });

    it("terminalizes stale persisted state when its queue retries were already exhausted", async () => {
        mockFindMany.mockResolvedValueOnce([{ id: "exhausted-job" }]);
        mockQueueGetJob.mockResolvedValueOnce({
            getState: jest.fn().mockResolvedValue("failed"),
        });
        mockGetJob.mockResolvedValueOnce({
            id: "exhausted-job",
            status: "resolving",
        });

        await expect(genericImportJobRunner.recoverActiveJobs()).resolves.toBe(
            1,
        );

        expect(mockQueueAdd).not.toHaveBeenCalled();
        expect(mockTransitionJob).toHaveBeenCalledWith(
            "exhausted-job",
            ["pending", "resolving", "creating_playlist"],
            {
                status: "failed",
                progress: 100,
                error: "Generic import job failed",
            },
        );
    });

    it("never requeues more than the recovery batch capacity in one sweep", async () => {
        mockFindMany.mockResolvedValueOnce(
            Array.from({ length: 101 }, (_, index) => ({
                id: `bounded-job-${index}`,
            })),
        );

        await expect(genericImportJobRunner.recoverActiveJobs()).resolves.toBe(
            100,
        );

        expect(mockQueueAdd).toHaveBeenCalledTimes(100);
        expect(mockQueueAdd).not.toHaveBeenCalledWith(
            "generic-import-run",
            { jobId: "bounded-job-100" },
            expect.anything(),
        );
    });

    it("registers bounded startup and periodic recovery jobs", async () => {
        await genericImportJobRunner.registerRecoveryJobs();

        expect(mockQueueReady).toHaveBeenCalledTimes(1);
        expect(mockQueueAdd).toHaveBeenNthCalledWith(
            1,
            "generic-import-recover",
            { trigger: "startup" },
            expect.objectContaining({
                jobId: "generic-import-recovery:startup",
                removeOnComplete: true,
                removeOnFail: true,
            }),
        );
        expect(mockQueueAdd).toHaveBeenNthCalledWith(
            2,
            "generic-import-recover",
            { trigger: "repeat" },
            expect.objectContaining({
                jobId: "generic-import-recovery:repeat",
                repeat: { every: 60_000 },
                removeOnComplete: true,
                removeOnFail: 10,
            }),
        );
    });

    it("rethrows retryable failures without prematurely making the job terminal", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-retry",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            status: "pending",
        });
        const retryableError = new Error("provider temporarily unavailable");
        mockPreviewImport.mockRejectedValueOnce(retryableError);

        await expect(
            genericImportJobRunner.runJob("job-retry", {
                retryFailures: true,
                finalAttempt: false,
            }),
        ).rejects.toBe(retryableError);

        expect(mockTransitionJob).not.toHaveBeenCalledWith(
            "job-retry",
            expect.any(Array),
            expect.objectContaining({ status: "failed" }),
        );
        expect(logger.warn).toHaveBeenCalledWith(
            "Import job attempt failed; queue retry remains",
            expect.objectContaining({
                jobId: "job-retry",
                error: retryableError,
            }),
        );
    });

    it("lets Bull retry a transient Spotify provider request error", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-spotify-retry",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            status: "pending",
        });
        const retryableError = new SpotifyPlaylistPaginationError(
            "Spotify playlist pagination failed; no partial import was created",
            {
                cause: { response: { status: 503 } },
                providerFailure: true,
            },
        );
        mockPreviewImport.mockRejectedValueOnce(retryableError);

        await expect(
            genericImportJobRunner.runJob("job-spotify-retry", {
                retryFailures: true,
                finalAttempt: false,
            }),
        ).rejects.toBe(retryableError);

        expect(mockTransitionJob).not.toHaveBeenCalledWith(
            "job-spotify-retry",
            expect.any(Array),
            expect.objectContaining({ status: "failed" }),
        );
    });

    it.each([
        [
            "incomplete playlist",
            new SpotifyPlaylistPaginationError(
                "Spotify playlist declared 10 items but returned 9; no partial import was created",
            ),
            "Spotify playlist declared 10 items but returned 9; no partial import was created",
        ],
        [
            "rate limit",
            Object.assign(new Error("raw Spotify provider response"), {
                response: { status: 429 },
            }),
            "Generic import job failed",
        ],
    ])(
        "terminalizes a non-retryable Spotify %s error on the first attempt",
        async (_kind, providerError, expectedMessage) => {
            mockGetJob.mockResolvedValue({
                id: "job-terminal-provider",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                status: "pending",
            });
            mockPreviewImport.mockRejectedValueOnce(providerError);

            await expect(
                genericImportJobRunner.runJob("job-terminal-provider", {
                    retryFailures: true,
                    finalAttempt: false,
                }),
            ).resolves.toBeUndefined();

            expect(mockTransitionJob).toHaveBeenLastCalledWith(
                "job-terminal-provider",
                ["pending", "resolving", "creating_playlist"],
                {
                    status: "failed",
                    progress: 100,
                    error: expectedMessage,
                },
            );
            expect(logger.warn).not.toHaveBeenCalledWith(
                "Import job attempt failed; queue retry remains",
                expect.anything(),
            );
        },
    );

    it("does not retry an untyped nested HTTP 429", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-http-429",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            status: "pending",
        });
        const http429 = new Error("provider details", {
            cause: { response: { status: 429 } },
        });
        mockPreviewImport.mockRejectedValueOnce(http429);

        await expect(
            genericImportJobRunner.runJob("job-http-429", {
                retryFailures: true,
                finalAttempt: false,
            }),
        ).resolves.toBeUndefined();
        expect(mockTransitionJob).toHaveBeenLastCalledWith(
            "job-http-429",
            ["pending", "resolving", "creating_playlist"],
            {
                status: "failed",
                progress: 100,
                error: "Generic import job failed",
            },
        );
    });

    it("stores only a safe failure after queue retries are exhausted", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-final-attempt",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            status: "pending",
        });
        const internalError = new Error(
            "postgresql://admin:secret@db/import failed",
        );
        mockPreviewImport.mockRejectedValueOnce(internalError);

        await expect(
            genericImportJobRunner.runJob("job-final-attempt", {
                retryFailures: true,
                finalAttempt: true,
            }),
        ).rejects.toBe(internalError);

        expect(mockTransitionJob).toHaveBeenLastCalledWith(
            "job-final-attempt",
            ["pending", "resolving", "creating_playlist"],
            {
                status: "failed",
                progress: 100,
                error: "Generic import job failed",
            },
        );
        expect(logger.error).toHaveBeenCalledWith(
            "Import job failed",
            expect.objectContaining({
                jobId: "job-final-attempt",
                error: internalError,
            }),
        );
    });

    it("runs a pending import job through preview and playlist creation", async () => {
        installStatefulJob({
            id: "job-1",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: "Roadtrip",
            playlistName: "Spotify import",
            status: "pending",
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            resolvedTracks: null,
        });
        mockPreviewImport.mockResolvedValue({
            playlistName: "Weekend Mix",
            resolved: [
                {
                    index: 0,
                    artist: "Artist",
                    title: "Song",
                    source: "local",
                    confidence: 100,
                    trackId: "track-1",
                },
            ],
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });
        mockImportPlaylist.mockResolvedValue({
            playlistId: "playlist-1",
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });

        await genericImportJobRunner.runJob("job-1");

        expect(mockTransitionJob).toHaveBeenNthCalledWith(
            1,
            "job-1",
            ["pending", "resolving"],
            {
                status: "resolving",
                progress: 20,
            },
        );
        expect(mockPreviewImport).toHaveBeenCalledWith(
            "user-1",
            "https://open.spotify.com/playlist/abc",
            expect.objectContaining({ onProgress: expect.any(Function) }),
        );
        expect(mockTransitionJob).toHaveBeenNthCalledWith(
            2,
            "job-1",
            ["resolving"],
            {
                status: "creating_playlist",
                progress: 70,
                playlistName: "Roadtrip",
                summary: {
                    total: 1,
                    local: 1,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
                resolvedTracks: [
                    {
                        index: 0,
                        artist: "Artist",
                        title: "Song",
                        source: "local",
                        confidence: 100,
                        trackId: "track-1",
                    },
                ],
            },
        );
        expect(mockImportPlaylist).toHaveBeenCalledWith(
            "user-1",
            {
                playlistName: "Roadtrip",
                resolved: [
                    {
                        index: 0,
                        artist: "Artist",
                        title: "Song",
                        source: "local",
                        confidence: 100,
                        trackId: "track-1",
                    },
                ],
                summary: {
                    total: 1,
                    local: 1,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            },
            "Roadtrip",
            { idempotencyKey: "job-1" },
        );
        expect(mockTransitionJob).toHaveBeenNthCalledWith(
            3,
            "job-1",
            ["creating_playlist"],
            {
                status: "creating_playlist",
            },
        );
        expect(mockTransitionJob).toHaveBeenNthCalledWith(
            4,
            "job-1",
            ["creating_playlist"],
            {
                status: "completed",
                progress: 100,
                summary: {
                    total: 1,
                    local: 1,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
                createdPlaylistId: "playlist-1",
                error: null,
            },
        );
    });

    it("persists bounded progress while a large preview is resolving", async () => {
        installStatefulJob({
            id: "job-progress",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/large",
            requestedPlaylistName: null,
            playlistName: "Large import",
            status: "pending",
            progress: 0,
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            resolvedTracks: null,
        });
        mockPreviewImport.mockImplementation(
            async (
                _userId: string,
                _sourceUrl: string,
                options: {
                    onProgress: (event: {
                        stage: string;
                        completed: number;
                        total: number;
                    }) => Promise<void>;
                },
            ) => {
                await options.onProgress({
                    stage: "source",
                    completed: 1_400,
                    total: 1_400,
                });
                await options.onProgress({
                    stage: "local",
                    completed: 1_400,
                    total: 1_400,
                });
                await options.onProgress({
                    stage: "youtube",
                    completed: 700,
                    total: 1_400,
                });
                return {
                    playlistName: "Large import",
                    resolved: [],
                    summary: {
                        total: 0,
                        local: 0,
                        youtube: 0,
                        tidal: 0,
                        unresolved: 0,
                    },
                };
            },
        );

        await (genericImportJobRunner as any).resolvePreview("job-progress");

        expect(
            mockTransitionJob.mock.calls.map(([, , update]) => update),
        ).toEqual([
            { status: "resolving", progress: 20 },
            { progress: 25 },
            { progress: 30 },
            { progress: 54 },
        ]);
    });

    it("reuses the job playlist identity after playlist commit but before completion persists", async () => {
        const initialSummary = {
            total: 0,
            local: 0,
            youtube: 0,
            tidal: 0,
            unresolved: 0,
        };
        const persistedPreview = {
            playlistName: "Committed Mix",
            resolved: [
                {
                    index: 0,
                    artist: "Stable Artist",
                    title: "Stable Track",
                    source: "youtube",
                    confidence: 85,
                    trackYtMusicId: "yt-stable",
                },
            ],
            summary: {
                total: 1,
                local: 0,
                youtube: 1,
                tidal: 0,
                unresolved: 0,
            },
        };
        const job = installStatefulJob({
            id: "job-committed-retry",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Pending source name",
            status: "pending",
            summary: initialSummary,
            resolvedTracks: null,
        });
        const playlistsByKey = new Map<string, string>();
        let logicalPlaylistCreations = 0;
        let failCompletionOnce = true;

        mockPreviewImport
            .mockResolvedValueOnce(persistedPreview)
            .mockRejectedValue(
                new Error("source changed after playlist transaction"),
            );
        mockImportPlaylist.mockImplementation(
            async (
                _userId: string,
                importPreview: typeof persistedPreview,
                _name: string | undefined,
                options?: { idempotencyKey?: string },
            ) => {
                const key = options?.idempotencyKey;
                if (!key) {
                    logicalPlaylistCreations += 1;
                    return {
                        playlistId: `playlist-${logicalPlaylistCreations}`,
                        summary: importPreview.summary,
                    };
                }
                let playlistId = playlistsByKey.get(key);
                if (!playlistId) {
                    logicalPlaylistCreations += 1;
                    playlistId = `playlist-${logicalPlaylistCreations}`;
                    playlistsByKey.set(key, playlistId);
                }
                return { playlistId, summary: importPreview.summary };
            },
        );
        mockTransitionJob.mockImplementation(
            async (
                _jobId: string,
                expectedStatuses: string[],
                update: {
                    status?: string;
                    playlistName?: string;
                    summary?: typeof persistedPreview.summary;
                    resolvedTracks?: typeof persistedPreview.resolved;
                },
            ) => {
                if (!expectedStatuses.includes(job.status)) {
                    return null;
                }
                if (update.status === "completed" && failCompletionOnce) {
                    failCompletionOnce = false;
                    throw new Error("completion write failed");
                }
                Object.assign(job, update);
                return { ...job };
            },
        );

        await expect(
            genericImportJobRunner.runJob("job-committed-retry", {
                retryFailures: true,
                finalAttempt: false,
            }),
        ).rejects.toThrow("completion write failed");
        await expect(
            genericImportJobRunner.runJob("job-committed-retry", {
                retryFailures: true,
                finalAttempt: false,
            }),
        ).resolves.toBeUndefined();

        expect(mockImportPlaylist).toHaveBeenCalledTimes(2);
        expect(mockPreviewImport).toHaveBeenCalledTimes(1);
        expect(mockImportPlaylist).toHaveBeenNthCalledWith(
            1,
            "user-1",
            persistedPreview,
            undefined,
            { idempotencyKey: "job-committed-retry" },
        );
        expect(mockImportPlaylist).toHaveBeenNthCalledWith(
            2,
            "user-1",
            persistedPreview,
            undefined,
            { idempotencyKey: "job-committed-retry" },
        );
        expect(logicalPlaylistCreations).toBe(1);
        expect(mockTransitionJob).toHaveBeenLastCalledWith(
            "job-committed-retry",
            ["creating_playlist"],
            expect.objectContaining({
                status: "completed",
                createdPlaylistId: "playlist-1",
            }),
        );
    });

    it("reconciles a committed playlist when the final completion write fails and replay stays idempotent", async () => {
        const summary = {
            total: 1,
            local: 0,
            youtube: 1,
            tidal: 0,
            unresolved: 0,
        };
        const preview = {
            playlistName: "Committed final mix",
            resolved: [
                {
                    index: 0,
                    artist: "Committed Artist",
                    title: "Committed Track",
                    source: "youtube" as const,
                    confidence: 90,
                    trackYtMusicId: "yt-committed-final",
                },
            ],
            summary,
        };
        const job = installStatefulJob({
            id: "job-final-commit-reconcile",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "pending",
            progress: 0,
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            resolvedTracks: null as unknown,
            createdPlaylistId: null as string | null,
            error: null as string | null,
        });
        let failCompletionOnce = true;
        mockPreviewImport.mockResolvedValueOnce(preview);
        mockImportPlaylist.mockResolvedValueOnce({
            playlistId: "playlist-final-commit",
            summary,
        });
        mockFindImportedPlaylistId.mockResolvedValueOnce(
            "playlist-final-commit",
        );
        mockTransitionJob.mockImplementation(
            async (
                _jobId: string,
                expectedStatuses: string[],
                update: Record<string, unknown>,
            ) => {
                if (!expectedStatuses.includes(job.status)) {
                    return null;
                }
                if (update.status === "completed" && failCompletionOnce) {
                    failCompletionOnce = false;
                    throw new Error("final completion write failed");
                }
                Object.assign(job, update);
                return { ...job };
            },
        );

        await expect(
            genericImportJobRunner.runJob(job.id, {
                retryFailures: true,
                finalAttempt: true,
            }),
        ).resolves.toBeUndefined();
        await expect(
            genericImportJobRunner.runJob(job.id),
        ).resolves.toBeUndefined();

        expect(mockImportPlaylist).toHaveBeenCalledTimes(1);
        expect(mockPreviewImport).toHaveBeenCalledTimes(1);
        expect(mockFindImportedPlaylistId).toHaveBeenCalledWith(
            "user-1",
            job.id,
        );
        expect(job.status).toBe("completed");
        expect(job.createdPlaylistId).toBe("playlist-final-commit");
        expect(job.summary).toEqual(summary);
        expect(mockTransitionJob).not.toHaveBeenCalledWith(
            job.id,
            expect.any(Array),
            expect.objectContaining({ status: "failed" }),
        );
    });

    it("promotes a concurrent failed loser after the playlist commit is known", async () => {
        const summary = {
            total: 0,
            local: 0,
            youtube: 0,
            tidal: 0,
            unresolved: 0,
        };
        const job = installStatefulJob({
            id: "job-commit-failed-race",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "pending",
            progress: 0,
            summary,
            resolvedTracks: null as unknown,
            createdPlaylistId: null as string | null,
            error: null as string | null,
        });
        let injectFailedWinner = true;
        mockPreviewImport.mockResolvedValueOnce({
            playlistName: "Committed Mix",
            resolved: [],
            summary,
        });
        mockImportPlaylist.mockResolvedValueOnce({
            playlistId: "playlist-commit-race",
            summary,
        });
        mockTransitionJob.mockImplementation(
            async (
                _jobId: string,
                expectedStatuses: string[],
                update: Record<string, unknown>,
            ) => {
                if (!expectedStatuses.includes(job.status)) {
                    return null;
                }
                if (update.status === "completed" && injectFailedWinner) {
                    injectFailedWinner = false;
                    job.status = "failed";
                    job.error = "stale worker failure";
                    return null;
                }
                Object.assign(job, update);
                return { ...job };
            },
        );

        await genericImportJobRunner.runJob(job.id);

        expect(job.status).toBe("completed");
        expect(job.createdPlaylistId).toBe("playlist-commit-race");
        expect(job.error).toBe(
            "Playlist creation completed; recovered import status after a persistence failure",
        );
    });

    it("reconciles a committed playlist before queue failure finalization", async () => {
        const summary = {
            total: 1,
            local: 1,
            youtube: 0,
            tidal: 0,
            unresolved: 0,
        };
        const job = installStatefulJob({
            id: "job-queue-finalize-committed",
            userId: "user-1",
            status: "creating_playlist",
            progress: 70,
            summary,
            createdPlaylistId: null as string | null,
            error: null as string | null,
        });
        mockFindImportedPlaylistId.mockResolvedValueOnce(
            "playlist-queue-committed",
        );

        await genericImportJobRunner.finalizeQueueFailure(
            job.id,
            new Error("completion acknowledgement lost"),
        );

        expect(job.status).toBe("completed");
        expect(job.createdPlaylistId).toBe("playlist-queue-committed");
        expect(job.summary).toEqual(summary);
    });

    it("imports only the persisted winner snapshot when concurrent previews diverge", async () => {
        const emptySummary = {
            total: 0,
            local: 0,
            youtube: 0,
            tidal: 0,
            unresolved: 0,
        };
        const previewA = {
            playlistName: "Preview A",
            resolved: [
                {
                    index: 0,
                    artist: "Artist A",
                    title: "Track A",
                    source: "youtube" as const,
                    confidence: 90,
                    trackYtMusicId: "yt-a",
                },
            ],
            summary: { ...emptySummary, total: 1, youtube: 1 },
        };
        const previewB = {
            playlistName: "Preview B",
            resolved: [
                {
                    index: 0,
                    artist: "Artist B",
                    title: "Track B",
                    source: "local" as const,
                    confidence: 100,
                    trackId: "track-b",
                },
            ],
            summary: { ...emptySummary, total: 1, local: 1 },
        };
        const persistedJob = {
            id: "job-divergent-previews",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "pending",
            progress: 0,
            summary: emptySummary,
            resolvedTracks: null as unknown,
            createdPlaylistId: null as string | null,
            error: null as string | null,
        };
        let persistedSnapshotWrites = 0;
        mockGetJob.mockImplementation(async () => ({ ...persistedJob }));
        mockTransitionJob.mockImplementation(
            async (
                _jobId: string,
                expectedStatuses: string[],
                update: Record<string, unknown>,
            ) => {
                if (!expectedStatuses.includes(persistedJob.status)) {
                    return null;
                }
                if (update.resolvedTracks !== undefined) {
                    persistedSnapshotWrites += 1;
                }
                Object.assign(persistedJob, update);
                return { ...persistedJob };
            },
        );

        const previewADeferred = createDeferred<typeof previewA>();
        const previewBDeferred = createDeferred<typeof previewB>();
        const bothPreviewsStarted = createDeferred<void>();
        let previewCalls = 0;
        mockPreviewImport.mockImplementation(async () => {
            previewCalls += 1;
            if (previewCalls === 2) {
                bothPreviewsStarted.resolve();
            }
            return previewCalls === 1
                ? previewADeferred.promise
                : previewBDeferred.promise;
        });

        const firstImportStarted = createDeferred<void>();
        const bothImportsStarted = createDeferred<void>();
        const releaseImports = createDeferred<void>();
        const importedPreviews: Array<typeof previewA | typeof previewB> = [];
        mockImportPlaylist.mockImplementation(
            async (_userId, preview: typeof previewA | typeof previewB) => {
                importedPreviews.push(preview);
                if (importedPreviews.length === 1) {
                    firstImportStarted.resolve();
                }
                if (importedPreviews.length === 2) {
                    bothImportsStarted.resolve();
                }
                await releaseImports.promise;
                return {
                    playlistId: "playlist-winner",
                    summary: preview.summary,
                };
            },
        );

        const workerA = genericImportJobRunner.runJob(persistedJob.id);
        const workerB = genericImportJobRunner.runJob(persistedJob.id);
        await bothPreviewsStarted.promise;
        previewBDeferred.resolve(previewB);
        await firstImportStarted.promise;
        previewADeferred.resolve(previewA);
        await bothImportsStarted.promise;
        releaseImports.resolve();
        await Promise.all([workerA, workerB]);

        expect(importedPreviews).toHaveLength(2);
        expect(importedPreviews).toEqual([previewB, previewB]);
        expect(persistedJob.resolvedTracks).toEqual(previewB.resolved);
        expect(persistedJob.summary).toEqual(previewB.summary);
        expect(persistedJob.playlistName).toBe(previewB.playlistName);
        expect(persistedJob.status).toBe("completed");
        expect(persistedJob.createdPlaylistId).toBe("playlist-winner");
        expect(persistedSnapshotWrites).toBe(1);
    });

    it("fences cancellation on a creating retry without replacing its persisted snapshot", async () => {
        const persistedResolvedTracks = [
            {
                index: 0,
                artist: "Persisted Artist",
                title: "Persisted Track",
                source: "youtube" as const,
                confidence: 90,
                trackYtMusicId: "yt-persisted",
            },
        ];
        const persistedSummary = {
            total: 1,
            local: 0,
            youtube: 1,
            tidal: 0,
            unresolved: 0,
        };
        const job = installStatefulJob({
            id: "job-creating-cancel-race",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Persisted Mix",
            status: "creating_playlist",
            progress: 70,
            summary: persistedSummary,
            resolvedTracks: persistedResolvedTracks,
        });
        mockTransitionJob.mockImplementation(
            async (
                _jobId: string,
                expectedStatuses: string[],
                update: Record<string, unknown>,
            ) => {
                const isSnapshotFence =
                    expectedStatuses.length === 1 &&
                    expectedStatuses[0] === "creating_playlist" &&
                    update.status === "creating_playlist" &&
                    Object.keys(update).length === 1;
                if (isSnapshotFence) {
                    job.status = "cancelling";
                    return null;
                }
                if (!expectedStatuses.includes(job.status)) {
                    return null;
                }
                Object.assign(job, update);
                return { ...job };
            },
        );

        await genericImportJobRunner.runJob(job.id);

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(job.status).toBe("cancelled");
        expect(job.resolvedTracks).toEqual(persistedResolvedTracks);
        expect(job.summary).toEqual(persistedSummary);
        expect(mockTransitionJob).not.toHaveBeenCalledWith(
            job.id,
            expect.any(Array),
            expect.objectContaining({ resolvedTracks: expect.anything() }),
        );
    });

    it("stops cleanly when the user deletes a job before snapshot claim", async () => {
        const job = {
            id: "job-deleted-before-snapshot",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "pending",
        };
        let deleted = false;
        mockGetJob.mockImplementation(async () =>
            deleted ? null : { ...job },
        );
        mockTransitionJob.mockImplementation(
            async (
                _jobId: string,
                expectedStatuses: string[],
                update: Record<string, unknown>,
            ) => {
                if (deleted || !expectedStatuses.includes(job.status)) {
                    return null;
                }
                Object.assign(job, update);
                return { ...job };
            },
        );
        mockPreviewImport.mockImplementationOnce(async () => {
            deleted = true;
            return {
                playlistName: "Deleted import",
                resolved: [],
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            };
        });

        await genericImportJobRunner.runJob(job.id);

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(mockTransitionJob).not.toHaveBeenCalledWith(
            job.id,
            expect.any(Array),
            expect.objectContaining({ status: "failed" }),
        );
    });

    it.each([
        {
            caseName: "empty provider identity",
            resolvedTracks: [
                {
                    index: 0,
                    artist: "Empty ID",
                    title: "Invalid Track",
                    source: "youtube",
                    confidence: 85,
                    trackYtMusicId: "",
                },
            ],
            summary: {
                total: 1,
                local: 0,
                youtube: 1,
                tidal: 0,
                unresolved: 0,
            },
        },
        {
            caseName: "whitespace provider identity",
            resolvedTracks: [
                {
                    index: 0,
                    artist: "Whitespace ID",
                    title: "Invalid Track",
                    source: "local",
                    confidence: 100,
                    trackId: "   ",
                },
            ],
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        },
        {
            caseName: "multiple provider identities",
            resolvedTracks: [
                {
                    index: 0,
                    artist: "Contradictory IDs",
                    title: "Invalid Track",
                    source: "youtube",
                    confidence: 85,
                    trackId: "local-id",
                    trackYtMusicId: "yt-id",
                },
            ],
            summary: {
                total: 1,
                local: 0,
                youtube: 1,
                tidal: 0,
                unresolved: 0,
            },
        },
        {
            caseName: "unresolved track with a provider identity",
            resolvedTracks: [
                {
                    index: 0,
                    artist: "Contradictory unresolved",
                    title: "Invalid Track",
                    source: "unresolved",
                    confidence: 0,
                    trackTidalId: "tidal-id",
                },
            ],
            summary: {
                total: 1,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 1,
            },
        },
        {
            caseName: "per-source count mismatch",
            resolvedTracks: [
                {
                    index: 0,
                    artist: "Stable Artist",
                    title: "Stable Track",
                    source: "youtube",
                    confidence: 85,
                    trackYtMusicId: "yt-stable",
                },
            ],
            summary: {
                total: 1,
                local: 1,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        },
    ])(
        "fails safely for $caseName instead of re-resolving the persisted snapshot",
        async ({ resolvedTracks, summary }) => {
            mockGetJob.mockResolvedValue({
                id: "job-invalid-snapshot",
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                playlistName: "Persisted Mix",
                status: "creating_playlist",
                summary,
                resolvedTracks,
            });

            await genericImportJobRunner.runJob("job-invalid-snapshot");

            expect(mockPreviewImport).not.toHaveBeenCalled();
            expect(mockImportPlaylist).not.toHaveBeenCalled();
            expect(mockTransitionJob).toHaveBeenLastCalledWith(
                "job-invalid-snapshot",
                ["pending", "resolving", "creating_playlist"],
                {
                    status: "failed",
                    progress: 100,
                    error: "Generic import job failed",
                },
            );
        },
    );

    it("marks the job failed when preview resolution throws", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-1",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            status: "pending",
        });
        mockPreviewImport.mockRejectedValue(new Error("preview failed"));

        await genericImportJobRunner.runJob("job-1");

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(mockTransitionJob).toHaveBeenLastCalledWith(
            "job-1",
            ["pending", "resolving", "creating_playlist"],
            {
                status: "failed",
                progress: 100,
                error: "Generic import job failed",
            },
        );
    });

    it("preserves a code-owned Spotify completeness error for the user", async () => {
        mockGetJob.mockResolvedValue({
            id: "job-spotify-connect",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            status: "pending",
        });
        mockPreviewImport.mockRejectedValue(
            new SpotifyPlaylistPaginationError(
                "Spotify playlist pagination was incomplete",
            ),
        );

        await genericImportJobRunner.runJob("job-spotify-connect");

        expect(mockTransitionJob).toHaveBeenLastCalledWith(
            "job-spotify-connect",
            ["pending", "resolving", "creating_playlist"],
            {
                status: "failed",
                progress: 100,
                error: "Spotify playlist pagination was incomplete",
            },
        );
    });

    it("stops before playlist creation when the job is cancelled mid-flight", async () => {
        const job = installStatefulJob({
            id: "job-1",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "pending",
        });
        mockPreviewImport.mockImplementationOnce(async () => {
            job.status = "cancelled";
            return {
                playlistName: "Weekend Mix",
                resolved: [],
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            };
        });

        await genericImportJobRunner.runJob("job-1");

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(job.status).toBe("cancelled");
    });

    it("marks the job cancelled when cancellation is requested before playlist creation starts", async () => {
        const job = installStatefulJob({
            id: "job-2",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "pending",
        });
        mockPreviewImport.mockImplementationOnce(async () => {
            job.status = "cancelling";
            return {
                playlistName: "Weekend Mix",
                resolved: [],
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            };
        });

        await genericImportJobRunner.runJob("job-2");

        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(job.status).toBe("cancelled");
        expect(mockTransitionJob).toHaveBeenLastCalledWith(
            "job-2",
            ["cancelling"],
            {
                status: "cancelled",
                progress: 100,
                error: "Cancelled by user",
            },
        );
    });

    it("records completion when cancellation arrives after playlist creation starts", async () => {
        const job = installStatefulJob({
            id: "job-3",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "pending",
        });
        mockPreviewImport.mockResolvedValue({
            playlistName: "Weekend Mix",
            resolved: [],
            summary: {
                total: 0,
                local: 0,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
        });
        mockImportPlaylist.mockImplementationOnce(async () => {
            job.status = "cancelling";
            return {
                playlistId: "playlist-late",
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            };
        });

        await genericImportJobRunner.runJob("job-3");

        expect(job.status).toBe("completed");
        expect(mockTransitionJob).toHaveBeenLastCalledWith(
            "job-3",
            ["cancelling"],
            {
                status: "completed",
                progress: 100,
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
                createdPlaylistId: "playlist-late",
                error: "Cancellation requested after playlist creation completed",
            },
        );
    });

    it("stops before preview when cancellation wins after the runnable read", async () => {
        const job = installStatefulJob({
            id: "job-cancel-before-preview",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "pending",
        });
        mockTransitionJob.mockImplementation(
            async (
                _jobId: string,
                expectedStatuses: string[],
                update: Record<string, unknown>,
            ) => {
                if (
                    expectedStatuses.includes("pending") &&
                    update.status === "resolving"
                ) {
                    job.status = "cancelling";
                    return null;
                }
                if (!expectedStatuses.includes(job.status)) {
                    return null;
                }
                Object.assign(job, update);
                return { ...job };
            },
        );

        await genericImportJobRunner.runJob(job.id);

        expect(mockPreviewImport).not.toHaveBeenCalled();
        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(job.status).toBe("cancelled");
    });

    it("stops before playlist creation when cancellation wins after preview", async () => {
        const job = installStatefulJob({
            id: "job-cancel-after-preview",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "pending",
        });
        mockPreviewImport.mockImplementationOnce(async () => {
            job.status = "cancelling";
            return {
                playlistName: "Weekend Mix",
                resolved: [],
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            };
        });

        await genericImportJobRunner.runJob(job.id);

        expect(mockPreviewImport).toHaveBeenCalledTimes(1);
        expect(mockImportPlaylist).not.toHaveBeenCalled();
        expect(job.status).toBe("cancelled");
    });

    it("does not replace a concurrently completed job with failure", async () => {
        const job = installStatefulJob({
            id: "job-completed-before-failure",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "pending",
        });
        mockTransitionJob.mockImplementation(
            async (
                _jobId: string,
                expectedStatuses: string[],
                update: Record<string, unknown>,
            ) => {
                if (update.status === "failed") {
                    job.status = "completed";
                    return null;
                }
                if (!expectedStatuses.includes(job.status)) {
                    return null;
                }
                Object.assign(job, update);
                return { ...job };
            },
        );
        mockPreviewImport.mockRejectedValueOnce(
            new Error("late provider failure"),
        );

        await genericImportJobRunner.runJob(job.id);

        expect(job.status).toBe("completed");
    });

    it.each(["completed", "cancelled"])(
        "does not overwrite %s when queue finalization loses the race",
        async (status) => {
            const job = installStatefulJob({
                id: `job-finalize-${status}`,
                status: "resolving",
            });
            mockTransitionJob.mockImplementationOnce(async () => {
                job.status = status;
                return null;
            });

            await genericImportJobRunner.finalizeQueueFailure(
                job.id,
                new Error("stale queue delivery"),
            );

            expect(job.status).toBe(status);
        },
    );

    it("does not let cancellation finalization overwrite a completed job", async () => {
        const job = installStatefulJob({
            id: "job-finish-cancel-race",
            userId: "user-1",
            sourceUrl: "https://open.spotify.com/playlist/abc",
            requestedPlaylistName: null,
            playlistName: "Spotify import",
            status: "cancelling",
        });
        mockTransitionJob.mockImplementationOnce(async () => {
            job.status = "completed";
            return null;
        });

        await genericImportJobRunner.runJob(job.id);

        expect(job.status).toBe("completed");
    });

    it.each([
        ["cancelled", "cancelled"],
        ["failed", "completed"],
    ])(
        "settles a %s race as %s after a playlist commit and keeps committed playlist metadata visible",
        async (status, expectedStatus) => {
            const job = installStatefulJob({
                id: `job-complete-${status}`,
                userId: "user-1",
                sourceUrl: "https://open.spotify.com/playlist/abc",
                requestedPlaylistName: null,
                playlistName: "Spotify import",
                status: "pending",
                createdPlaylistId: null as string | null,
                error: null as string | null,
            });
            mockPreviewImport.mockResolvedValueOnce({
                playlistName: "Committed Mix",
                resolved: [],
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            });
            mockImportPlaylist.mockImplementationOnce(async () => {
                job.status = status;
                return {
                    playlistId: "playlist-committed",
                    summary: {
                        total: 0,
                        local: 0,
                        youtube: 0,
                        tidal: 0,
                        unresolved: 0,
                    },
                };
            });
            await genericImportJobRunner.runJob(job.id);

            expect(job.status).toBe(expectedStatus);
            expect(job.createdPlaylistId).toBe("playlist-committed");
            if (status === "failed") {
                expect(job.error).toBe(
                    "Playlist creation completed; recovered import status after a persistence failure",
                );
            }
        },
    );
});
