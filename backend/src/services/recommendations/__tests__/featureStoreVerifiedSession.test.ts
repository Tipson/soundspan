const mockSessionPlays = jest.fn();
const mockSessionMappings = jest.fn();
const mockSessionFeatures = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        play: { findMany: mockSessionPlays },
        trackMapping: { findMany: mockSessionMappings },
        canonicalRecording: { findMany: jest.fn().mockResolvedValue([]) },
        $queryRaw: mockSessionFeatures,
    },
}));

import { recommendationFeatureStore } from "../featureStore";

const NOW = new Date("2026-10-08T12:00:00Z");
const providers = ["vk", "yandex"] as const;
function namespace(provider: (typeof providers)[number]) {
    const id = provider === "vk" ? "-001_002" : "0007";
    return {
        provider,
        providerTrackId: id,
        verifiedMetadata: {
            provider,
            id,
            title: "Confirmed song",
            artists: ["Confirmed artist"],
            duration: 180,
            contentVersion: "clean",
            preview: false,
        },
        metadataObservedAt: NOW,
        metadataConnectionVersion: 2,
        mappings: [
            {
                stale: false,
                canonicalRecordingId: provider,
                canonicalRecording: {
                    id: provider,
                    mergedIntoId: null,
                    identitySource: "verified-source",
                    embeddings: [
                        { space: { status: "active", cleaningAt: null } },
                    ],
                },
            },
        ],
    };
}
function play(provider: (typeof providers)[number], index = 0) {
    return {
        id: `${provider}-${String(index).padStart(3, "0")}`,
        userId: "alice",
        recommendationSessionId: "session-a",
        source: provider === "vk" ? "VK" : "YANDEX",
        trackId: null,
        trackTidalId: null,
        trackYtMusicId: null,
        trackMusicSource: namespace(provider),
        playedAt: new Date(NOW.getTime() - index * 1_000),
        outcome: "completed" as string | null,
        completionRatio: 1 as number | null,
        listenedSeconds: 180 as number | null,
    };
}
function legacy(index = 0) {
    return {
        ...play("vk", index),
        id: `legacy-${index}`,
        source: "YOUTUBE_MUSIC",
        trackYtMusicId: "legacy-youtube",
        trackMusicSource: null,
    };
}
type SessionPlay = ReturnType<typeof play> | ReturnType<typeof legacy>;
let corpus: SessionPlay[];
let vectors: Record<string, string | null>;

function useCorpus() {
    mockSessionPlays.mockImplementation(async (query) => {
        const direct = !query.where.source?.notIn;
        const nativePredicates = query.where.OR ?? query.where.AND?.[0]?.OR;
        const rows = corpus
            .filter((row) => {
                if (
                    row.userId !== query.where.userId ||
                    row.recommendationSessionId !==
                        query.where.recommendationSessionId
                )
                    return false;
                if (!direct)
                    return !query.where.source.notIn.includes(row.source);
                if (row.outcome === "failed") return false;
                return nativePredicates?.some((branch: any) => {
                    const ns = row.trackMusicSource;
                    const where = branch.trackMusicSource.is;
                    if (
                        row.source !== branch.source ||
                        !ns ||
                        ns.provider !== where.provider ||
                        !ns.verifiedMetadata ||
                        !ns.metadataObservedAt ||
                        !(ns.metadataConnectionVersion > 0)
                    )
                        return false;
                    return ns.mappings.some((mapping) => {
                        const canonical = mapping.canonicalRecording;
                        return (
                            !mapping.stale &&
                            !canonical.mergedIntoId &&
                            canonical.identitySource !== "identity-merged" &&
                            canonical.embeddings.some(
                                ({ space }) =>
                                    space.status === "active" &&
                                    space.cleaningAt === null,
                            )
                        );
                    });
                });
            })
            .sort(
                (a, b) =>
                    b.playedAt.getTime() - a.playedAt.getTime() ||
                    a.id.localeCompare(b.id),
            );
        const offset = query.cursor
            ? rows.findIndex((row) => row.id === query.cursor.id) + query.skip
            : 0;
        if (query.cursor && offset === 0) return [];
        if (direct && query.select.musicSourceRecording)
            throw new Error("Private display must not be read as shared facts");
        return rows.slice(offset, offset + query.take);
    });
    mockSessionMappings.mockImplementation(async (query) =>
        query.where.OR?.some((branch: any) => branch.trackYtMusicId)
            ? [
                  {
                      trackId: null,
                      trackTidalId: null,
                      trackYtMusicId: "legacy-youtube",
                      canonicalRecordingId: "legacy",
                  },
              ]
            : [],
    );
    mockSessionFeatures.mockImplementation(async (_strings, ids) =>
        Array.isArray(ids)
            ? ids.map((canonicalRecordingId) => ({
                  canonicalRecordingId,
                  embedding: vectors[canonicalRecordingId],
              }))
            : [],
    );
}
function context(userId = "alice", sessionId = "session-a") {
    return recommendationFeatureStore.loadTasteContext(userId, { sessionId });
}

describe("confirmed direct plays reach the actual fast session profile", () => {
    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW);
        jest.clearAllMocks();
        corpus = [];
        vectors = { vk: "[1,0]", yandex: "[0,1]", legacy: "[0.6,0.8]" };
        useCorpus();
    });
    afterEach(() => jest.useRealTimers());

    it.each(providers)("uses exact %s completed listens", async (provider) => {
        corpus = [play(provider)];
        const result = await context();
        expect(result.sessionSignalCount).toBe(1);
        expect(result.sessionPositiveEmbedding).toEqual(
            provider === "vk" ? [1, 0] : [0, 1],
        );
        expect(result.sessionNegativeEmbedding).toBeNull();
    });

    it.each(providers)("uses %s early skip evidence only", async (provider) => {
        const skipped = play(provider);
        skipped.outcome = "skipped";
        skipped.completionRatio = null;
        skipped.listenedSeconds = 4;
        corpus = [skipped];
        const result = await context();
        expect(result.sessionSignalCount).toBe(1);
        expect(result.sessionNegativeEmbedding).toEqual(
            provider === "vk" ? [1, 0] : [0, 1],
        );
        expect(result.sessionPositiveEmbedding).toBeNull();
    });

    it.each(providers)(
        "keeps %s failed/unknown skip neutral",
        async (provider) => {
            const failed = play(provider);
            failed.outcome = "failed";
            const unknown = play(provider, 1);
            unknown.outcome = "skipped";
            unknown.completionRatio = unknown.listenedSeconds = null;
            corpus = [failed, unknown];
            const result = await context();
            expect(result.sessionSignalCount).toBe(0);
            expect(result.sessionPositiveEmbedding).toBeNull();
            expect(result.sessionNegativeEmbedding).toBeNull();
        },
    );

    it.each(providers)(
        "retains %s nullable meaningful evidence",
        async (provider) => {
            const row = play(provider);
            row.outcome = null;
            row.completionRatio = null;
            row.listenedSeconds = 240;
            corpus = [row];
            expect((await context()).sessionSignalCount).toBe(1);
        },
    );

    it("isolates account/session before native quota", async () => {
        corpus = [
            ...Array.from({ length: 30 }, (_, i) => ({
                ...play("vk", i),
                userId: "bob",
            })),
            ...Array.from({ length: 30 }, (_, i) => ({
                ...play("vk", i + 30),
                recommendationSessionId: "different-session",
            })),
            play("yandex", 70),
        ];
        const result = await context();
        expect(result.sessionSignalCount).toBe(1);
        expect(result.sessionPositiveEmbedding).toEqual([0, 1]);
    });

    it.each(["provider", "id", "preview", "artist", "source"])(
        "rejects conflicting %s without losing the legacy signal",
        async (conflict) => {
            const weak = play("vk");
            if (conflict === "source") weak.source = "YANDEX";
            else if (conflict === "provider")
                weak.trackMusicSource.verifiedMetadata.provider = "yandex";
            else if (conflict === "id")
                weak.trackMusicSource.verifiedMetadata.id = "1_2";
            else if (conflict === "preview")
                weak.trackMusicSource.verifiedMetadata.preview = true;
            else weak.trackMusicSource.verifiedMetadata.artists = [];
            corpus = [weak, legacy(1)];
            const result = await context();
            expect(result.sessionSignalCount).toBe(1);
            expect(result.sessionPositiveEmbedding).toEqual([0.6, 0.8]);
        },
    );

    it.each(["stale", "merged", "retired", "cleaning", "missing"])(
        "rejects %s namespace mappings before quota",
        async (kind) => {
            const invalid = play("vk");
            const mapping = invalid.trackMusicSource.mappings[0];
            if (kind === "stale") mapping.stale = true;
            else if (kind === "merged")
                mapping.canonicalRecording.identitySource = "identity-merged";
            else if (kind === "retired")
                mapping.canonicalRecording.embeddings[0].space.status =
                    "retired";
            else if (kind === "cleaning")
                (
                    mapping.canonicalRecording.embeddings[0].space as any
                ).cleaningAt = NOW;
            else invalid.trackMusicSource.mappings = [];
            corpus = [invalid, play("yandex", 1)];
            const result = await context();
            expect(result.sessionSignalCount).toBe(1);
            expect(result.sessionPositiveEmbedding).toEqual([0, 1]);
        },
    );

    it("passes a full weak page with its last raw cursor", async () => {
        corpus = Array.from({ length: 30 }, (_, i) => {
            const row = play("vk", i);
            row.trackMusicSource.verifiedMetadata.artists = [];
            return row;
        });
        corpus.push(play("yandex", 30));
        const result = await context();
        expect(result.sessionSignalCount).toBe(1);
        expect(result.sessionPositiveEmbedding).toEqual([0, 1]);
        const queries = mockSessionPlays.mock.calls
            .map(([query]) => query)
            .filter((query) => !query.where.source?.notIn);
        expect(queries).toHaveLength(2);
        expect(queries[1]).toEqual(
            expect.objectContaining({
                cursor: { id: "vk-029" },
                skip: 1,
                take: 30,
            }),
        );
    });

    it("caps a pathological scan and keeps legacy taste", async () => {
        corpus = Array.from({ length: 301 }, (_, i) => {
            const row = play("vk", i);
            row.trackMusicSource.verifiedMetadata.artists = [];
            return row;
        });
        corpus.push(legacy(400));
        const result = await context();
        expect(result.sessionSignalCount).toBe(1);
        expect(result.sessionPositiveEmbedding).toEqual([0.6, 0.8]);
        expect(
            mockSessionPlays.mock.calls.filter(([q]) => !q.where.source?.notIn),
        ).toHaveLength(10);
    });

    it("applies a chronological global30 after parsed meaningful vectors", async () => {
        corpus = [
            ...Array.from({ length: 31 }, (_, i) => play("vk", i)),
            ...Array.from({ length: 30 }, (_, i) => legacy(i + 40)),
        ];
        const result = await context();
        expect(result.sessionSignalCount).toBe(30);
        expect(result.sessionPositiveEmbedding).toEqual([1, 0]);
        vectors.vk = "invalid";
        const legacyOnly = await context();
        expect(legacyOnly.sessionSignalCount).toBe(30);
        expect(legacyOnly.sessionPositiveEmbedding![0]).toBeCloseTo(0.6);
        expect(legacyOnly.sessionPositiveEmbedding![1]).toBeCloseTo(0.8);
    });

    it("does not let thirty neutral direct listens consume legacy slots", async () => {
        corpus = Array.from({ length: 30 }, (_, i) => {
            const row = play("vk", i);
            row.outcome = "skipped";
            row.completionRatio = row.listenedSeconds = null;
            return row;
        });
        corpus.push(legacy(40));
        const result = await context();
        expect(result.sessionSignalCount).toBe(1);
        expect(result.sessionPositiveEmbedding).toEqual([0.6, 0.8]);
    });

    it("retains the existing 45-minute half life across providers", async () => {
        const old = play("vk");
        old.playedAt = new Date(NOW.getTime() - 45 * 60_000);
        corpus = [old, play("yandex")];
        const result = await context();
        expect(result.sessionSignalCount).toBe(2);
        expect(result.sessionPositiveEmbedding![0]).toBeCloseTo(
            1 / Math.sqrt(5),
        );
        expect(result.sessionPositiveEmbedding![1]).toBeCloseTo(
            2 / Math.sqrt(5),
        );
    });
});
