import path from "node:path";

const mockMkdir = jest.fn().mockResolvedValue(undefined);
const mockRm = jest.fn().mockResolvedValue(undefined);
const mockPipeline = jest.fn().mockResolvedValue(undefined);
const mockGetStreamProxy = jest.fn().mockResolvedValue({ data: {} });
const mockEmbedAudio = jest.fn();
const mockFetchProviderSpace = jest.fn();
const mockResolveProviderEmbeddingSpace = jest.fn();
const mockLogWarn = jest.fn();

const mockPrisma: any = {
    play: { findMany: jest.fn() },
    trackMapping: { findMany: jest.fn() },
    analysisAssetLease: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
    },
    canonicalRecording: {
        findMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
    },
    embeddingSpace: { updateMany: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn(
        async (input: unknown): Promise<unknown> =>
            typeof input === "function"
                ? (input as (transaction: unknown) => Promise<unknown>)(
                      mockPrisma,
                  )
                : Promise.all(input as Promise<unknown>[]),
    ),
};

jest.mock("node:fs", () => ({ createWriteStream: jest.fn(() => ({})) }));
jest.mock("node:fs/promises", () => ({ mkdir: mockMkdir, rm: mockRm }));
jest.mock("node:stream/promises", () => ({ pipeline: mockPipeline }));
jest.mock("../../../config", () => ({
    config: {
        recommendations: {
            remoteAnalysisEnabled: true,
            remoteAnalysisDailyBudget: 100,
        },
        features: { audioAnalysis: true },
        music: { musicPath: "/music" },
    },
}));
jest.mock("../../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../../utils/redis", () => ({
    redisClient: { eval: jest.fn() },
}));
jest.mock("../../tidalStreaming", () => ({ tidalStreamingService: {} }));
jest.mock("../../youtubeMusic", () => ({
    ytMusicService: { getStreamProxy: mockGetStreamProxy },
}));
jest.mock("../../vibeProvider", () => ({
    embedAudio: mockEmbedAudio,
    fetchProviderSpace: mockFetchProviderSpace,
}));
jest.mock("../../embeddingSpaces", () => ({
    resolveProviderEmbeddingSpace: mockResolveProviderEmbeddingSpace,
}));
jest.mock("../onlineIdentityEnrichment", () => ({
    onlineIdentityEnricher: { enrich: jest.fn() },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: mockLogWarn }) },
}));

import {
    claimRemoteAnalysisDailyBudget,
    isRemoteAnalysisLeaseConflict,
    loadRemoteAnalysisCoveredCanonicalIds,
    loadAccountHotSetCandidates,
    processRemoteAnalysis,
    recoverExpiredRemoteAnalysisAssets,
    RemoteAnalysisHotSetScheduler,
    resolveAnalysisSpoolPath,
} from "../remoteAnalysisHotSet";
import { redisClient } from "../../../utils/redis";
import type { RecommendationCandidate } from "../types";

function candidate(
    id: string,
    source: "youtube" | "tidal" = "youtube",
): RecommendationCandidate {
    const tidalId = source === "tidal" ? Number(id) : null;
    const youtubeVideoId = source === "youtube" ? id : null;
    return {
        id: source === "youtube" ? `yt:${id}` : `tidal:${id}`,
        canonicalKey: `meta:${source}:${id}`,
        canonicalRecordingId: `canonical-${source}-${id}`,
        title: id,
        duration: 180,
        artist: { id: null, name: "artist" },
        album: { id: null, title: "album", coverArt: null },
        source,
        provider: { tidalTrackId: tidalId, youtubeVideoId },
        streamSource: source,
        candidateSources: [`${source}-radio`],
        providerPrior: 1,
    };
}

describe("remote recommendation hot set", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockMkdir.mockResolvedValue(undefined);
        mockRm.mockResolvedValue(undefined);
        mockPipeline.mockResolvedValue(undefined);
        mockGetStreamProxy.mockResolvedValue({ data: {} });
        mockPrisma.analysisAssetLease.update.mockResolvedValue({});
        mockPrisma.analysisAssetLease.create.mockResolvedValue({
            id: "lease-1",
        });
        mockPrisma.canonicalRecording.update.mockResolvedValue({});
        mockPrisma.play.findMany.mockResolvedValue([]);
        mockPrisma.trackMapping.findMany.mockResolvedValue([]);
        mockPrisma.embeddingSpace.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.$queryRaw.mockResolvedValue([{ dim: 512 }]);
        mockPrisma.$executeRaw.mockResolvedValue(1);
        (redisClient.eval as jest.Mock).mockResolvedValue(1);
    });

    it("lets a Bull retry pass the scheduler-only failed-analysis cooldown", async () => {
        mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);

        await loadRemoteAnalysisCoveredCanonicalIds(["canonical-retry"], false);

        const query = mockPrisma.canonicalRecording.findMany.mock.calls[0]?.[0];
        expect(query.where.OR).not.toContainEqual(
            expect.objectContaining({ analysisStatus: "failed" }),
        );
    });

    it("requires both scalar and embedding analysis before treating a canonical as complete", async () => {
        mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);

        await loadRemoteAnalysisCoveredCanonicalIds(["canonical-partial"]);

        const query = mockPrisma.canonicalRecording.findMany.mock.calls[0]?.[0];
        expect(query.where.OR).toContainEqual({
            AND: expect.arrayContaining([
                { analysisStatus: "completed" },
                { embeddingStatus: "completed" },
                expect.objectContaining({ embeddings: expect.any(Object) }),
            ]),
        });
        expect(query.where.OR).toContainEqual(
            expect.objectContaining({
                embeddingStatus: "failed",
                embeddingAnalyzedAt: expect.any(Object),
            }),
        );
    });

    it("recognizes only Prisma unique conflicts as an active-lease race", () => {
        expect(isRemoteAnalysisLeaseConflict({ code: "P2002" })).toBe(true);
        expect(isRemoteAnalysisLeaseConflict({ code: "P2003" })).toBe(false);
        expect(isRemoteAnalysisLeaseConflict(new Error("P2002"))).toBe(false);
    });

    it("returns the winning active lease when concurrent Bull deliveries collide", async () => {
        mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);
        mockPrisma.canonicalRecording.findUniqueOrThrow.mockResolvedValue({
            analysisStatus: "pending",
            embeddingStatus: "pending",
            embeddings: [],
        });
        mockPrisma.analysisAssetLease.create.mockRejectedValue({
            code: "P2002",
        });

        await expect(
            processRemoteAnalysis({
                data: {
                    userId: "alice",
                    canonicalRecordingId: "canonical-race",
                    provider: "youtube",
                    providerTrackId: "video-race",
                },
            } as never),
        ).resolves.toEqual({ status: "already-in-flight" });
        expect(mockGetStreamProxy).not.toHaveBeenCalled();
    });

    it("uses the public YouTube context for account-scoped hot-set audio", async () => {
        mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);
        mockPrisma.canonicalRecording.findUniqueOrThrow.mockResolvedValue({
            analysisStatus: "pending",
            embeddingStatus: "pending",
            embeddings: [],
        });
        mockFetchProviderSpace.mockResolvedValue({ id: "provider" });
        mockResolveProviderEmbeddingSpace.mockResolvedValue({
            space: { id: "space-1" },
        });
        mockEmbedAudio.mockResolvedValue(Array(512).fill(0.01));

        await expect(
            processRemoteAnalysis({
                data: {
                    userId: "account-without-youtube-oauth",
                    canonicalRecordingId: "canonical-public-stream",
                    provider: "youtube",
                    providerTrackId: "video-public-stream",
                },
            } as never),
        ).resolves.toEqual({ status: "queued" });

        expect(mockGetStreamProxy).toHaveBeenCalledWith(
            "__public__",
            "video-public-stream",
            "medium",
            undefined,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
    });

    it("logs a bounded download failure classification without upstream headers", async () => {
        mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);
        mockPrisma.canonicalRecording.findUniqueOrThrow.mockResolvedValue({
            analysisStatus: "pending",
            embeddingStatus: "pending",
            embeddings: [],
        });
        const upstreamError = Object.assign(
            new Error("Request failed with status code 401"),
            {
                code: "ERR_BAD_REQUEST",
                response: { status: 401 },
                config: {
                    headers: { "x-internal-secret": "must-not-be-logged" },
                },
            },
        );
        mockGetStreamProxy.mockRejectedValueOnce(upstreamError);

        await expect(
            processRemoteAnalysis({
                data: {
                    userId: "alice",
                    canonicalRecordingId: "canonical-download-error",
                    provider: "youtube",
                    providerTrackId: "video-download-error",
                },
            } as never),
        ).rejects.toBe(upstreamError);

        expect(mockLogWarn).toHaveBeenCalledWith(
            "Remote analysis processing failed",
            {
                canonicalRecordingId: "canonical-download-error",
                provider: "youtube",
                stage: "download",
                errorName: "Error",
                errorMessage: "Request failed with status code 401",
                errorCode: "ERR_BAD_REQUEST",
                upstreamStatus: 401,
            },
        );
        expect(JSON.stringify(mockLogWarn.mock.calls)).not.toContain(
            "must-not-be-logged",
        );
    });

    it("keeps DCLAP failure retryable after successful Essentia hand-off", async () => {
        mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);
        mockPrisma.canonicalRecording.findUniqueOrThrow.mockResolvedValue({
            analysisStatus: "pending",
            embeddingStatus: "pending",
            embeddings: [],
        });
        mockFetchProviderSpace.mockResolvedValue({ id: "provider" });
        mockResolveProviderEmbeddingSpace.mockResolvedValue({
            space: { id: "space-1" },
        });
        mockEmbedAudio.mockRejectedValue(new Error("temporary DCLAP outage"));

        await expect(
            processRemoteAnalysis({
                data: {
                    userId: "alice",
                    canonicalRecordingId: "canonical-partial",
                    provider: "youtube",
                    providerTrackId: "video-partial",
                },
            } as never),
        ).resolves.toEqual({ status: "queued-essentia-dclap-degraded" });

        expect(mockPrisma.canonicalRecording.update).toHaveBeenCalledWith({
            where: { id: "canonical-partial" },
            data: expect.objectContaining({
                embeddingStatus: "failed",
                embeddingError: "DCLAP embedding analysis failed",
                embeddingAnalyzedAt: expect.any(Date),
            }),
        });
        expect(mockPrisma.canonicalRecording.update).toHaveBeenCalledWith({
            where: { id: "canonical-partial" },
            data: { analysisStatus: "processing", analysisError: null },
        });
    });

    it("finishes an embedding-only retry without re-queueing completed scalar analysis", async () => {
        mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);
        mockPrisma.canonicalRecording.findUniqueOrThrow.mockResolvedValue({
            analysisStatus: "completed",
            embeddingStatus: "failed",
            embeddings: [],
        });
        mockFetchProviderSpace.mockResolvedValue({ id: "provider" });
        mockResolveProviderEmbeddingSpace.mockResolvedValue({
            space: { id: "space-1" },
        });
        mockEmbedAudio.mockResolvedValue(Array(512).fill(0.01));

        await expect(
            processRemoteAnalysis({
                data: {
                    userId: "alice",
                    canonicalRecordingId: "canonical-embedding-retry",
                    provider: "youtube",
                    providerTrackId: "video-embedding-retry",
                },
            } as never),
        ).resolves.toEqual({ status: "embedding-completed" });

        expect(mockPrisma.canonicalRecording.update).toHaveBeenCalledWith({
            where: { id: "canonical-embedding-retry" },
            data: expect.objectContaining({
                embeddingStatus: "completed",
                embeddingVersion: "space-1",
            }),
        });
        expect(mockPrisma.analysisAssetLease.update).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ status: "queued_essentia" }),
            }),
        );
    });

    it("persists cleanup_failed when a terminal remote asset cannot be removed", async () => {
        mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);
        mockPrisma.canonicalRecording.findUniqueOrThrow.mockResolvedValue({
            analysisStatus: "completed",
            embeddingStatus: "pending",
            embeddings: [],
        });
        mockFetchProviderSpace.mockResolvedValue({ id: "provider" });
        mockResolveProviderEmbeddingSpace.mockResolvedValue({
            space: { id: "space-1" },
        });
        mockEmbedAudio.mockResolvedValue(Array(512).fill(0.01));
        mockRm.mockRejectedValueOnce(new Error("file is locked"));

        await expect(
            processRemoteAnalysis({
                data: {
                    userId: "alice",
                    canonicalRecordingId: "canonical-cleanup",
                    provider: "youtube",
                    providerTrackId: "video-cleanup",
                },
            } as never),
        ).resolves.toEqual({ status: "embedding-completed" });

        expect(mockPrisma.analysisAssetLease.update).toHaveBeenCalledWith({
            where: { id: "lease-1" },
            data: expect.objectContaining({
                status: "cleanup_failed",
                expiresAt: expect.any(Date),
                error: "Terminal asset cleanup failed",
            }),
        });
    });

    it("aborts an endlessly slow remote asset before its lease can expire", async () => {
        jest.useFakeTimers();
        try {
            mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);
            mockPrisma.canonicalRecording.findUniqueOrThrow.mockResolvedValue({
                analysisStatus: "pending",
                embeddingStatus: "pending",
                embeddings: [],
            });
            const stream = { destroy: jest.fn() };
            const observedSignals: AbortSignal[] = [];
            mockGetStreamProxy.mockImplementation(
                async (
                    _userId: string,
                    _trackId: string,
                    _quality: string,
                    _range: string | undefined,
                    options?: { signal?: AbortSignal },
                ) => {
                    if (options?.signal) observedSignals.push(options.signal);
                    return { data: stream };
                },
            );
            mockPipeline.mockImplementation(
                async (...args: unknown[]) =>
                    new Promise((_resolve, reject) => {
                        const options = args.at(-1) as {
                            signal?: AbortSignal;
                        };
                        options.signal?.addEventListener(
                            "abort",
                            () =>
                                reject(
                                    options.signal?.reason ??
                                        new Error("aborted"),
                                ),
                            { once: true },
                        );
                    }),
            );

            const result = processRemoteAnalysis({
                data: {
                    userId: "alice",
                    canonicalRecordingId: "canonical-slow-download",
                    provider: "youtube",
                    providerTrackId: "video-slow-download",
                },
            } as never);
            const rejection = expect(result).rejects.toThrow(
                "Remote analysis asset download deadline exceeded",
            );
            await jest.advanceTimersByTimeAsync(15 * 60 * 1_000);

            await rejection;
            expect(observedSignals).toHaveLength(1);
            expect(observedSignals[0]?.aborted).toBe(true);
            expect(stream.destroy).toHaveBeenCalledWith(expect.any(Error));
            expect(mockRm).toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    it("reclaims an expired failed lease when immediate file cleanup did not succeed", async () => {
        mockPrisma.analysisAssetLease.findMany.mockResolvedValue([
            {
                id: "lease-failed",
                spoolRef: ".soundspan-analysis-spool/failed.audio",
                canonicalRecordingId: "canonical-failed",
            },
        ]);
        mockPrisma.analysisAssetLease.updateMany.mockResolvedValue({
            count: 1,
        });
        mockPrisma.analysisAssetLease.update.mockResolvedValue({});
        mockPrisma.canonicalRecording.updateMany.mockResolvedValue({
            count: 0,
        });

        await expect(recoverExpiredRemoteAnalysisAssets()).resolves.toBe(1);

        const query = mockPrisma.analysisAssetLease.findMany.mock.calls[0]?.[0];
        expect(query.where.status.notIn).not.toContain("failed");
        expect(mockPrisma.analysisAssetLease.update).toHaveBeenCalledWith({
            where: { id: "lease-failed" },
            data: { status: "expired", error: "Lease expired" },
        });
    });

    it("deduplicates canonical work and skips recordings already fully analyzed", async () => {
        const dependencies = {
            enabled: true,
            loadCoveredCanonicalIds: jest
                .fn()
                .mockResolvedValue(new Set(["canonical-youtube-done"])),
            enqueue: jest.fn().mockResolvedValue(undefined),
        };
        const scheduler = new RemoteAnalysisHotSetScheduler(dependencies);
        const duplicate = candidate("fresh");

        await scheduler.schedule({
            userId: "alice",
            sessionId: "session-a",
            surface: "wave",
            candidates: [
                candidate("done"),
                candidate("fresh"),
                duplicate,
                candidate("42", "tidal"),
                { ...candidate("invalid"), canonicalRecordingId: null },
            ],
        });

        expect(dependencies.enqueue.mock.calls).toEqual([
            [
                expect.objectContaining({
                    canonicalRecordingId: "canonical-youtube-fresh",
                    provider: "youtube",
                    providerTrackId: "fresh",
                    userId: "alice",
                }),
                "remote-analysis:canonical-youtube-fresh",
            ],
            [
                expect.objectContaining({
                    canonicalRecordingId: "canonical-tidal-42",
                    provider: "tidal",
                    providerTrackId: "42",
                }),
                "remote-analysis:canonical-tidal-42",
            ],
        ]);
    });

    it("prioritizes durable account hot-set signals before the current response", async () => {
        const callOrder: string[] = [];
        const dependencies = {
            enabled: true,
            loadAccountCandidates: jest
                .fn()
                .mockResolvedValue([candidate("liked"), candidate("playlist")]),
            enrichIdentities: jest.fn().mockImplementation(async () => {
                callOrder.push("enrich");
            }),
            resolveCanonicalIdentities: jest
                .fn()
                .mockImplementation(async (candidates) => {
                    callOrder.push("resolve");
                    return candidates.map((item: RecommendationCandidate) =>
                        item.id === "yt:liked"
                            ? {
                                  ...item,
                                  canonicalRecordingId: "canonical-merged",
                                  canonicalKey: "canonical:canonical-merged",
                              }
                            : item,
                    );
                }),
            loadCoveredCanonicalIds: jest.fn().mockResolvedValue(new Set()),
            enqueue: jest.fn().mockImplementation(async () => {
                callOrder.push("enqueue");
            }),
        };
        const scheduler = new RemoteAnalysisHotSetScheduler(dependencies);

        await scheduler.schedule({
            userId: "alice",
            sessionId: "session-a",
            surface: "wave",
            candidates: [candidate("response")],
        });

        expect(
            dependencies.enqueue.mock.calls.map(
                (call) => call[0].providerTrackId,
            ),
        ).toEqual(["liked", "playlist", "response"]);
        expect(dependencies.enqueue.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                canonicalRecordingId: "canonical-merged",
            }),
        );
        expect(callOrder.slice(0, 2)).toEqual(["enrich", "resolve"]);
        expect(callOrder[2]).toBe("enqueue");
        expect(dependencies.enrichIdentities).toHaveBeenCalledWith(
            "alice",
            expect.arrayContaining([
                expect.objectContaining({ id: "yt:liked" }),
                expect.objectContaining({ id: "yt:response" }),
            ]),
        );
    });

    it("still analyzes the current response when account hot-set loading fails", async () => {
        const dependencies = {
            enabled: true,
            loadAccountCandidates: jest
                .fn()
                .mockRejectedValue(new Error("database timeout")),
            loadCoveredCanonicalIds: jest.fn().mockResolvedValue(new Set()),
            enqueue: jest.fn().mockResolvedValue(undefined),
        };
        const scheduler = new RemoteAnalysisHotSetScheduler(dependencies);

        await scheduler.schedule({
            userId: "alice",
            sessionId: "session-a",
            surface: "wave",
            candidates: [candidate("response")],
        });

        expect(dependencies.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ providerTrackId: "response" }),
            "remote-analysis:canonical-youtube-response",
        );
    });

    it("refreshes canonical mappings even when optional identity enrichment fails", async () => {
        const current = candidate("response");
        const dependencies = {
            enabled: true,
            enrichIdentities: jest
                .fn()
                .mockRejectedValue(new Error("tidal unavailable")),
            resolveCanonicalIdentities: jest.fn().mockResolvedValue([
                {
                    ...current,
                    canonicalRecordingId: "canonical-refreshed",
                },
            ]),
            loadCoveredCanonicalIds: jest.fn().mockResolvedValue(new Set()),
            enqueue: jest.fn().mockResolvedValue(undefined),
        };
        const scheduler = new RemoteAnalysisHotSetScheduler(dependencies);

        await scheduler.schedule({
            userId: "alice",
            sessionId: "session-a",
            surface: "wave",
            candidates: [current],
        });

        expect(dependencies.resolveCanonicalIdentities).toHaveBeenCalled();
        expect(dependencies.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                canonicalRecordingId: "canonical-refreshed",
            }),
            "remote-analysis:canonical-refreshed",
        );
    });

    it("admits only genuinely repeated provider tracks into the repeated hot set", async () => {
        mockPrisma.play.findMany.mockResolvedValue([
            { trackYtMusicId: "yt-row", trackTidalId: null },
            { trackYtMusicId: "yt-row", trackTidalId: null },
            { trackYtMusicId: "single-row", trackTidalId: null },
        ]);
        mockPrisma.trackMapping.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    canonicalRecordingId: "canonical-repeated",
                    trackYtMusic: {
                        id: "yt-row",
                        videoId: "video-repeated",
                        title: "Repeated",
                        artist: "Artist",
                        album: "Album",
                        duration: 180,
                        thumbnailUrl: null,
                    },
                    trackTidal: null,
                },
            ]);

        const candidates = await loadAccountHotSetCandidates("alice");

        expect(candidates).toEqual([
            expect.objectContaining({
                id: "yt:video-repeated",
                candidateSources: ["hot-repeated"],
            }),
        ]);
        const repeatedQuery = mockPrisma.trackMapping.findMany.mock.calls[4][0];
        expect(repeatedQuery.where.OR).toContainEqual({
            trackYtMusicId: { in: ["yt-row"] },
        });
        expect(JSON.stringify(repeatedQuery)).not.toContain("single-row");
    });

    it("does not touch the queue while remote analysis is disabled", async () => {
        const dependencies = {
            enabled: false,
            loadCoveredCanonicalIds: jest.fn(),
            enqueue: jest.fn(),
        };
        const scheduler = new RemoteAnalysisHotSetScheduler(dependencies);

        await scheduler.schedule({
            userId: "alice",
            sessionId: "session-a",
            surface: "home",
            candidates: [candidate("fresh")],
        });

        expect(dependencies.loadCoveredCanonicalIds).not.toHaveBeenCalled();
        expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it("confines every temporary asset to the hidden music spool", () => {
        const musicPath = path.resolve("C:/music");
        expect(
            resolveAnalysisSpoolPath(
                musicPath,
                ".soundspan-analysis-spool/job.webm",
            ),
        ).toBe(path.join(musicPath, ".soundspan-analysis-spool", "job.webm"));
        expect(() =>
            resolveAnalysisSpoolPath(musicPath, "../outside.webm"),
        ).toThrow("Invalid analysis spool reference");
        expect(() =>
            resolveAnalysisSpoolPath(musicPath, "album/song.webm"),
        ).toThrow("Invalid analysis spool reference");
    });

    it("keeps an exhausted canonical reservation denied on every retry", async () => {
        const evaluate = redisClient.eval as jest.MockedFunction<
            typeof redisClient.eval
        >;
        evaluate.mockResolvedValue(0);
        const now = new Date("2026-09-01T10:00:00.000Z");

        await expect(
            claimRemoteAnalysisDailyBudget("canonical-1", now),
        ).resolves.toBe(false);
        await expect(
            claimRemoteAnalysisDailyBudget("canonical-1", now),
        ).resolves.toBe(false);

        expect(evaluate).toHaveBeenCalledTimes(2);
        expect(evaluate.mock.calls[0]?.[1]).toEqual({
            keys: [
                "recommendation:remote-analysis:reservation:2026-09-01:canonical-1",
                "recommendation:remote-analysis:budget:2026-09-01",
            ],
            arguments: ["100", String(2 * 24 * 60 * 60)],
        });
    });
});
