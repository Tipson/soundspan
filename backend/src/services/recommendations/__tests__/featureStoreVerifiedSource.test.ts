const mockQueryRaw = jest.fn();
const mockDislikes = jest.fn();
const mockMappings = jest.fn();
const mockSeedMapping = jest.fn();
const mockCanonicals = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        $queryRaw: mockQueryRaw,
        dislikedEntity: { findMany: mockDislikes },
        trackMapping: { findMany: mockMappings, findFirst: mockSeedMapping },
        canonicalRecording: { findMany: mockCanonicals },
        play: { findMany: jest.fn().mockResolvedValue([]) },
    },
}));

import {
    loadLikedTasteEmbeddings,
    recommendationFeatureStore,
} from "../featureStore";

function namespace(provider: "vk" | "yandex", id: string) {
    return {
        provider,
        providerTrackId: id,
        verifiedMetadata: {
            provider,
            id,
            title: "Server confirmed song",
            artists: ["Artist", "Guest"],
            duration: 180,
            contentVersion: "clean",
            preview: false,
        },
        metadataObservedAt: new Date("2026-10-08T08:00:00Z"),
        metadataConnectionVersion: 2,
    };
}

const refs = [
    { provider: "vk" as const, id: "-001_002", vector: [1, 0] },
    { provider: "yandex" as const, id: "0007", vector: [0, 1] },
];
let storedNamespaces = refs.map((ref) => namespace(ref.provider, ref.id));
let legacyLikes = false;
const key = (index: number) =>
    `provider:${refs[index].provider}:${refs[index].id}`;
const canonicalId = (index: number) => `canonical-${index}`;
const mapping = (index: number) => ({
    id: `mapping-${index}`,
    trackMusicSource: storedNamespaces[index],
    canonicalRecordingId: canonicalId(index),
    canonicalRecording: {
        id: canonicalId(index),
        canonicalKey: key(index),
        mergedIntoId: null,
        identitySource: "verified-source",
    },
});

beforeEach(() => {
    jest.clearAllMocks();
    storedNamespaces = refs.map((ref) => namespace(ref.provider, ref.id));
    legacyLikes = false;
    mockCanonicals.mockImplementation(async (query) => {
        if (query.where.id?.in)
            return query.where.id.in.map((id: string) => ({ id }));
        const filter = query.where.mappings?.some;
        if (
            filter?.trackMusicSource &&
            filter.trackMusicSource.is.likedTracks.some.userId === "alice"
        )
            return refs.map((_, index) => ({
                id: canonicalId(index),
                mappings: [mapping(index)],
            }));
        return legacyLikes && filter?.track?.is.likedBy.some.userId === "alice"
            ? [{ id: "legacy" }]
            : [];
    });
    mockDislikes.mockImplementation(async (query) => {
        if (query.where.userId !== "alice") return [];
        let values = refs.map((ref) => `${ref.provider}:${ref.id}`);
        const prefix = query.where.entityId?.startsWith;
        if (prefix) values = values.filter((id) => id.startsWith(prefix));
        if (query.where.NOT)
            values = values.filter(
                (id) => !id.startsWith("vk:") && !id.startsWith("yandex:"),
            );
        return values.slice(0, query.take).map((entityId) => ({ entityId }));
    });
    mockMappings.mockImplementation(async (query) => {
        if (query.where.trackMusicSource)
            return !query.cursor &&
                query.where.trackMusicSource.is.likedTracks.some.userId ===
                    "alice"
                ? refs.map((_, index) => mapping(index))
                : [];
        const direct = query.where.OR?.filter(
            (entry: any) => entry.trackMusicSource,
        );
        if (!direct?.length) return [];
        return refs.flatMap((ref, index) =>
            direct.some((entry: any) => {
                const identity = entry.trackMusicSource.is;
                return (
                    identity.provider === ref.provider &&
                    (identity.providerTrackId === ref.id ||
                        identity.providerTrackId?.in?.includes(ref.id))
                );
            })
                ? [mapping(index)]
                : [],
        );
    });
    // A hostile legacy ID collision must never authorize a reserved direct seed.
    mockSeedMapping.mockResolvedValue({ canonicalRecordingId: "wrong-legacy" });
    mockQueryRaw.mockImplementation(async (_strings, ids) => {
        if (!Array.isArray(ids)) return [];
        return ids.map((id) => ({
            canonicalRecordingId: id,
            embedding: JSON.stringify(
                id === "legacy"
                    ? [0.5, 0.5]
                    : (refs.find((_, index) => canonicalId(index) === id)
                          ?.vector ?? [1, 1]),
            ),
            bpm: 100,
            energy: 0.5,
            valence: 0.5,
            danceability: 0.5,
            instrumentalness: 0.1,
        }));
    });
});

describe("verified direct feedback reaches actual feature-store readers", () => {
    it("includes exact current direct saved vectors beside the legacy reserve", async () => {
        legacyLikes = true;
        expect(await loadLikedTasteEmbeddings("alice")).toEqual([
            [0.5, 0.5],
            [1, 0],
            [0, 1],
        ]);
        expect(await loadLikedTasteEmbeddings("bob")).toEqual([]);
        const queries = mockCanonicals.mock.calls.map(([query]) => query);
        expect(queries.every((query) => query.take === 500)).toBe(true);
        expect(
            mockMappings.mock.calls.filter(
                ([query]) => query.where.trackMusicSource,
            ),
        ).toHaveLength(2);
    });

    it("resolves direct dislikes to exact canonical keys without requiring an embedding", async () => {
        expect(
            await recommendationFeatureStore.loadDislikedCanonicalKeys("alice"),
        ).toEqual(new Set(refs.map((_, index) => key(index))));
        expect(
            await recommendationFeatureStore.loadDislikedCanonicalKeys("bob"),
        ).toEqual(new Set());
        expect(mockQueryRaw).not.toHaveBeenCalled();
        for (const [query] of mockMappings.mock.calls)
            expect(
                query.where.canonicalRecording.is.embeddings,
            ).toBeUndefined();
    });

    it.each(refs)(
        "loads the exact $provider seed including leading zeros",
        async (ref) => {
            expect(
                await recommendationFeatureStore.loadSeedEmbedding(
                    `${ref.provider}:${ref.id}`,
                ),
            ).toEqual(ref.vector);
            expect(mockSeedMapping).not.toHaveBeenCalled();
        },
    );

    it.each([
        "vk:bad",
        "vk:",
        "vk:-1_",
        "yandex:",
        "yandex:7x",
        " yandex:0007",
        "vk:-001_002 ",
        "vk:-001_002\n",
        "yandex:0007\n",
    ])(
        "never treats reserved malformed seed %s as a legacy ID",
        async (seed) => {
            expect(
                await recommendationFeatureStore.loadSeedEmbedding(seed),
            ).toBeNull();
            expect(mockSeedMapping).not.toHaveBeenCalled();
            expect(mockQueryRaw).not.toHaveBeenCalled();
        },
    );

    it.each([
        [
            "provider mismatch",
            (row: any) => {
                row.verifiedMetadata.provider = "yandex";
            },
        ],
        [
            "id mismatch",
            (row: any) => {
                row.verifiedMetadata.id = "1_2";
            },
        ],
        [
            "preview",
            (row: any) => {
                row.verifiedMetadata.preview = true;
            },
        ],
        [
            "missing confirmation",
            (row: any) => {
                row.metadataObservedAt = null;
            },
        ],
        [
            "weak artist facts",
            (row: any) => {
                row.verifiedMetadata.artists = [];
            },
        ],
    ])(
        "rejects %s without losing another provider or saved legacy vector",
        async (_label, corrupt) => {
            corrupt(storedNamespaces[0]);
            legacyLikes = true;
            expect(await loadLikedTasteEmbeddings("alice")).toEqual([
                [0.5, 0.5],
                [0, 1],
            ]);
            expect(
                await recommendationFeatureStore.loadDislikedCanonicalKeys(
                    "alice",
                ),
            ).toEqual(new Set([key(1)]));
            expect(
                await recommendationFeatureStore.loadSeedEmbedding(
                    `vk:${refs[0].id}`,
                ),
            ).toBeNull();
        },
    );

    it("keeps unanalysed exact seeds neutral", async () => {
        mockQueryRaw.mockResolvedValue([]);
        expect(
            await recommendationFeatureStore.loadSeedEmbedding("yandex:0007"),
        ).toBeNull();
    });

    it.each(["weak", "duplicate"])(
        "continues through a full %s mapping page using its raw cursor",
        async (kind) => {
            const first = Array.from({ length: 500 }, (_, index) => {
                const row = namespace("vk", `-1_${index + 1}`);
                if (kind === "weak") row.verifiedMetadata.artists = [" "];
                return {
                    ...mapping(0),
                    id: `page-one-${index}`,
                    trackMusicSource: row,
                };
            });
            mockMappings.mockImplementation(async (query) =>
                query.cursor ? [mapping(1)] : first,
            );
            expect(await loadLikedTasteEmbeddings("alice")).toEqual(
                kind === "weak"
                    ? [[0, 1]]
                    : [
                          [1, 0],
                          [0, 1],
                      ],
            );
            expect(mockMappings).toHaveBeenCalledTimes(2);
            expect(mockMappings.mock.calls[1][0]).toEqual(
                expect.objectContaining({
                    cursor: { id: "page-one-499" },
                    skip: 1,
                    take: 500,
                }),
            );
        },
    );

    it("caps pathological weak data without consuming the legacy reserve", async () => {
        legacyLikes = true;
        mockMappings.mockImplementation(async () =>
            Array.from({ length: 500 }, (_, index) => {
                const row = namespace("vk", `-1_${index + 1}`);
                row.verifiedMetadata.artists = [" "];
                return {
                    ...mapping(0),
                    id: `weak-${mockMappings.mock.calls.length}-${index}`,
                    trackMusicSource: row,
                };
            }),
        );
        expect(await loadLikedTasteEmbeddings("alice")).toEqual([[0.5, 0.5]]);
        expect(mockMappings).toHaveBeenCalledTimes(10);
        expect(
            mockMappings.mock.calls.every(([query]) => query.take === 500),
        ).toBe(true);
    });

    it("preserves existing legacy seed lookup", async () => {
        expect(
            await recommendationFeatureStore.loadSeedEmbedding(
                "yt:legacy-video",
            ),
        ).toEqual([1, 1]);
        expect(mockSeedMapping).toHaveBeenCalledTimes(1);
    });

    it.each(refs)(
        "keeps $provider taste when another mapping for the same canonical has weak facts",
        async (ref) => {
            const weak = namespace(ref.provider, ref.id);
            weak.verifiedMetadata.artists = [" "];
            const valid = namespace(
                ref.provider,
                ref.provider === "vk" ? "-1_3" : "0008",
            );
            const rows = [weak, valid].map((trackMusicSource, index) => ({
                id: `mapping-${index}`,
                trackMusicSource,
                canonicalRecording: { id: "canonical-0", canonicalKey: key(0) },
            }));
            mockCanonicals.mockImplementation(async (query) => {
                if (query.where.id?.in)
                    return query.where.id.in.map((id: string) => ({ id }));
                if (!query.where.mappings?.some.trackMusicSource) return [];
                return [
                    {
                        id: "canonical-0",
                        mappings: rows.slice(0, query.select.mappings.take),
                    },
                ];
            });
            mockMappings.mockImplementation(async (query) =>
                query.where.trackMusicSource && !query.cursor ? rows : [],
            );
            expect(await loadLikedTasteEmbeddings("alice")).toEqual([[1, 0]]);
        },
    );
});
