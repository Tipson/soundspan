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
        findUnique: jest.fn(),
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

test("test-account playback cannot admit analysis or identity enrichment", async () => {
    const dependencies = {
        enabled: true,
        isAccountEligible: jest.fn(async () => false),
        loadCoveredCanonicalIds: jest.fn(async () => new Set<string>()),
        loadAccountCandidates: jest.fn(async () => []),
        enrichIdentities: jest.fn(async () => undefined),
        enqueue: jest.fn(async () => undefined),
    };
    const scheduler = new RemoteAnalysisHotSetScheduler(dependencies);
    await scheduler.schedule({
        userId: "test-user",
        sessionId: "test-session",
        surface: "wave",
        candidates: [candidate("test-track")],
    });
    expect(dependencies.isAccountEligible).toHaveBeenCalledWith("test-user");
    expect(dependencies.loadAccountCandidates).not.toHaveBeenCalled();
    expect(dependencies.enrichIdentities).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
});

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
        mockPrisma.canonicalRecording.findMany
            .mockReset()
            .mockResolvedValue([]);
        mockPrisma.canonicalRecording.findUnique.mockResolvedValue({
            mergedIntoId: null,
            identitySource: "metadata",
        });
        mockPrisma.play.findMany.mockResolvedValue([]);
        mockPrisma.trackMapping.findMany.mockResolvedValue([]);
        mockPrisma.embeddingSpace.updateMany.mockResolvedValue({ count: 1 });
        mockPrisma.$queryRaw.mockResolvedValue([{ dim: 512 }]);
        mockPrisma.$executeRaw.mockResolvedValue(1);
        (redisClient.eval as jest.Mock).mockResolvedValue(1);
    });

    it("rejects a persisted legacy TIDAL job before budget, lease or YouTube dispatch", async () => {
        const persistedJob = JSON.parse(
            '{"userId":"alice","canonicalRecordingId":"legacy-canonical","provider":"tidal","providerTrackId":"12345678901"}',
        );
        mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);
        mockPrisma.canonicalRecording.findUniqueOrThrow.mockResolvedValue({
            analysisStatus: "pending",
            embeddingStatus: "pending",
            embeddings: [],
        });
        mockGetStreamProxy.mockRejectedValue(
            new Error("Unexpected YouTube dispatch for legacy source"),
        );

        await expect(
            processRemoteAnalysis({ data: persistedJob } as never),
        ).rejects.toThrow("Invalid remote analysis job");
        expect(mockPrisma.canonicalRecording.findMany).not.toHaveBeenCalled();
        expect(redisClient.eval).not.toHaveBeenCalled();
        expect(mockMkdir).not.toHaveBeenCalled();
        expect(mockPrisma.analysisAssetLease.create).not.toHaveBeenCalled();
        expect(mockGetStreamProxy).not.toHaveBeenCalled();
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
        expect(query.where.OR).toContainEqual({ mergedIntoId: { not: null } });
        expect(query.where.OR).toContainEqual({
            identitySource: "identity-merged",
        });
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

    it("does not create analysis work for a canonical that merged during admission", async () => {
        mockPrisma.canonicalRecording.findMany.mockResolvedValue([]);
        mockPrisma.canonicalRecording.findUniqueOrThrow.mockResolvedValue({
            analysisStatus: "pending",
            embeddingStatus: "pending",
            embeddings: [],
        });
        mockPrisma.canonicalRecording.findUnique.mockResolvedValue({
            mergedIntoId: "canonical-survivor",
            identitySource: "identity-merged",
        });

        await expect(
            processRemoteAnalysis({
                data: {
                    userId: "user-1",
                    canonicalRecordingId: "canonical-alias",
                    provider: "youtube",
                    providerTrackId: "video-alias",
                },
            } as never),
        ).resolves.toEqual({ status: "canonical-merged" });
        expect(mockPrisma.analysisAssetLease.create).not.toHaveBeenCalled();
        expect(mockPipeline).not.toHaveBeenCalled();
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
            expect.objectContaining({
                signal: expect.any(AbortSignal),
                purpose: "analysis",
            }),
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
        ]);
    });

    it("admits current input even when all48 durable account candidates are already covered", async () => {
        const account = Array.from({ length: 48 }, (_, index) =>
            candidate(`covered-${index}`),
        );
        const current = candidate("current-wave");
        const dependencies = {
            enabled: true,
            loadAccountCandidates: jest.fn().mockResolvedValue(account),
            enrichIdentities: jest.fn().mockResolvedValue(undefined),
            resolveCanonicalIdentities: jest.fn(
                async (items: RecommendationCandidate[]) => items,
            ),
            loadCoveredCanonicalIds: jest
                .fn()
                .mockResolvedValue(
                    new Set(account.map((item) => item.canonicalRecordingId!)),
                ),
            enqueue: jest.fn().mockResolvedValue(undefined),
        };
        await new RemoteAnalysisHotSetScheduler(dependencies).schedule({
            userId: "alice",
            sessionId: "current-session",
            surface: "wave",
            candidates: [current],
        });
        expect(dependencies.enrichIdentities).toHaveBeenCalledWith(
            "alice",
            expect.arrayContaining([current]),
        );
        expect(
            dependencies.resolveCanonicalIdentities.mock.calls[0][0],
        ).toHaveLength(48);
        expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
        expect(dependencies.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ providerTrackId: "current-wave" }),
            "remote-analysis:canonical-youtube-current-wave",
        );
    });

    it("deduplicates before admission capacity and merges current/account provenance without mutating inputs", async () => {
        const current = {
            ...candidate("shared"),
            candidateSources: ["current-seed"],
        };
        const account = {
            ...candidate("shared"),
            title: "account metadata",
            candidateSources: ["hot-liked"],
        };
        const tail = candidate("unique-tail");
        const snapshot = structuredClone({ current, account });
        const enrichIdentities = jest.fn().mockResolvedValue(undefined);
        const enqueue = jest.fn().mockResolvedValue(undefined);
        await new RemoteAnalysisHotSetScheduler({
            enabled: true,
            loadAccountCandidates: async () => [account],
            enrichIdentities,
            loadCoveredCanonicalIds: async () => new Set(),
            enqueue,
        }).schedule({
            userId: "alice",
            sessionId: "current-session",
            surface: "wave",
            candidates: [...Array.from({ length: 48 }, () => current), tail],
        });
        expect(enqueue).toHaveBeenCalledTimes(2);
        expect(enrichIdentities.mock.calls[0][1]).toEqual([
            { ...current, candidateSources: ["current-seed", "hot-liked"] },
            tail,
        ]);
        expect({ current, account }).toEqual(snapshot);
    });

    it("reserves collection admission while retaining fresh recommendations and listening signals", async () => {
        const batch = (prefix: string, source: string, count: number) =>
            Array.from({ length: count }, (_, index) => ({
                ...candidate(`${prefix}-${index}`),
                candidateSources: [source],
            }));
        const collections = batch("liked", "hot-liked", 16);
        const history = batch("history", "hot-wave-seed", 32);
        const account = history.flatMap((item, index) =>
            index < collections.length ? [item, collections[index]] : [item],
        );
        const enqueue = jest.fn().mockResolvedValue(undefined);
        const scheduler = new RemoteAnalysisHotSetScheduler({
            enabled: true,
            loadAccountCandidates: async () => account,
            loadCoveredCanonicalIds: async () => new Set<string>(),
            enqueue,
        });
        await scheduler.schedule({
            userId: "alice",
            sessionId: "collection-budget",
            surface: "wave",
            candidates: batch("response", "youtube-radio", 48),
        });
        const ids = enqueue.mock.calls.map(
            ([job]) => job.providerTrackId as string,
        );
        expect(ids).toHaveLength(48);
        expect(ids.filter((id) => id.startsWith("liked-"))).toHaveLength(16);
        expect(ids.filter((id) => id.startsWith("response-"))).toHaveLength(16);
        expect(ids.filter((id) => id.startsWith("history-"))).toHaveLength(16);
        expect(new Set(ids).size).toBe(48);
    });

    it("prioritizes current seeds while retaining durable account signals and canonical refresh", async () => {
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
        ).toEqual(["response", "liked", "playlist"]);
        expect(dependencies.enqueue.mock.calls[1]?.[0]).toEqual(
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
                .mockRejectedValue(new Error("identity lookup unavailable")),
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
        mockPrisma.canonicalRecording.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    id: "canonical-repeated",
                    recordingMbid: null,
                    isrc: null,
                    mappings: [
                        {
                            trackYtMusic: {
                                id: "yt-row",
                                videoId: "video-repeated",
                                title: "Repeated",
                                artist: "Artist",
                                album: "Album",
                                duration: 180,
                                thumbnailUrl: null,
                            },
                        },
                    ],
                },
            ])
            .mockResolvedValueOnce([]);

        const candidates = await loadAccountHotSetCandidates("alice");

        expect(candidates).toEqual([
            expect.objectContaining({
                id: "yt:video-repeated",
                candidateSources: ["hot-repeated"],
            }),
        ]);
        const repeatedQuery =
            mockPrisma.canonicalRecording.findMany.mock.calls[8][0];
        expect(repeatedQuery.select.mappings.where.AND).toContainEqual({
            trackYtMusicId: { in: ["yt-row"] },
        });
        expect(JSON.stringify(repeatedQuery)).not.toContain("single-row");
    });

    function mapping(id: string) {
        return {
            canonicalRecordingId: `canonical-${id}`,
            trackYtMusic: {
                id,
                videoId: id,
                title: id,
                artist: "Artist",
                album: "Album",
                duration: 180,
                thumbnailUrl: null,
            },
        };
    }

    function signalBatches(batches: ReturnType<typeof mapping>[][]) {
        mockPrisma.canonicalRecording.findMany.mockReset();
        for (const rows of batches) {
            const canonicalRows = rows.map((row) => ({
                id: row.canonicalRecordingId,
                recordingMbid: null,
                isrc: null,
                mappings: [{ trackYtMusic: row.trackYtMusic }],
            }));
            mockPrisma.canonicalRecording.findMany.mockResolvedValueOnce(
                canonicalRows.slice(0, 16),
            );
            mockPrisma.canonicalRecording.findMany.mockResolvedValueOnce(
                canonicalRows.slice(16, 20),
            );
        }
        mockPrisma.play.findMany.mockResolvedValue(
            batches[4].flatMap((row) => [
                { trackYtMusicId: row.trackYtMusic.id },
                { trackYtMusicId: row.trackYtMusic.id },
            ]),
        );
    }

    it("admits all five full durable signal pools fairly within48 and retains likes/seed precedence", async () => {
        const sources = [
            "hot-liked",
            "hot-wave-seed",
            "hot-completed",
            "hot-playlist",
            "hot-repeated",
        ];
        const batches = sources.map((source) =>
            Array.from({ length: 20 }, (_, index) =>
                mapping(`${source}-${index}`),
            ),
        );
        signalBatches(batches);
        const result = await loadAccountHotSetCandidates("alice");
        expect(result).toHaveLength(48);
        expect(
            new Set(result.map((item) => item.canonicalRecordingId)).size,
        ).toBe(48);
        expect(
            result.slice(0, 5).map((item) => item.candidateSources[0]),
        ).toEqual(sources);
        expect(
            sources.map(
                (source) =>
                    result.filter((item) =>
                        item.candidateSources.includes(source),
                    ).length,
            ),
        ).toEqual([10, 10, 10, 9, 9]);
        expect(mockPrisma.canonicalRecording.findMany).toHaveBeenCalledTimes(
            10,
        );
        for (const [
            index,
            [query],
        ] of mockPrisma.canonicalRecording.findMany.mock.calls.entries()) {
            expect(query.take).toBe(index % 2 ? 4 : 16);
            expect(query.select.mappings.take).toBe(1);
            expect(query.select.mappings.where.AND).toContainEqual({
                stale: false,
                trackYtMusic: { isNot: null },
            });
            expect(query.where.AND).toContainEqual({
                mappings: { some: query.select.mappings.where },
            });
        }
        expect(mockPrisma.play.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: "alice", trackYtMusicId: { not: null } },
                take: 500,
            }),
        );
    });

    it("merges late duplicate provenance past the capacity cutoff without replacing preferred metadata", async () => {
        const batches = Array.from({ length: 5 }, (_, signal) =>
            Array.from({ length: 20 }, (_, index) =>
                mapping(`${signal}-${index}`),
            ),
        );
        batches[4][19] = {
            ...mapping("0-16"),
            trackYtMusic: {
                ...mapping("0-16").trackYtMusic,
                title: "less preferred",
            },
        };
        const original = structuredClone(batches);
        signalBatches(batches);
        const result = await loadAccountHotSetCandidates("alice");
        const shared = result.find(
            (item) => item.canonicalRecordingId === "canonical-0-16",
        );
        expect(shared?.candidateSources).toEqual(["hot-liked", "hot-repeated"]);
        expect(shared?.title).toBe("0-16");
        expect(result).toHaveLength(48);
        expect(batches).toEqual(original);
    });

    it("merges one canonical shared by all signals without duplicate admission", async () => {
        signalBatches(Array.from({ length: 5 }, () => [mapping("shared")]));
        const result = await loadAccountHotSetCandidates("alice");
        expect(result).toHaveLength(1);
        expect(result[0].candidateSources).toEqual([
            "hot-liked",
            "hot-wave-seed",
            "hot-completed",
            "hot-playlist",
            "hot-repeated",
        ]);
    });

    it("reclaims empty and duplicate-only signal slots without inventing candidates", async () => {
        const liked = Array.from({ length: 20 }, (_, index) =>
            mapping(`liked-${index}`),
        );
        const playlist = Array.from({ length: 20 }, (_, index) =>
            mapping(`playlist-${index}`),
        );
        signalBatches([liked, [], [], playlist, liked]);
        const result = await loadAccountHotSetCandidates("alice");
        expect(result).toHaveLength(40);
        expect(
            result.filter((item) =>
                item.candidateSources.includes("hot-liked"),
            ),
        ).toHaveLength(20);
        expect(
            result.filter((item) =>
                item.candidateSources.includes("hot-repeated"),
            ),
        ).toHaveLength(20);
        expect(
            new Set(result.map((item) => item.canonicalRecordingId)).size,
        ).toBe(40);
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
