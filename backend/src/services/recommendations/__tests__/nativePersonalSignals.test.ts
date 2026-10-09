const mockLikes = jest.fn(),
    mockPlays = jest.fn(),
    mockNamespaces = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: {
        likedRemoteTrack: {
            findMany: (...args: unknown[]) => mockLikes(...args),
        },
        play: { findMany: (...args: unknown[]) => mockPlays(...args) },
        trackMusicSource: {
            findMany: (...args: unknown[]) => mockNamespaces(...args),
        },
    },
}));
jest.mock("../../youtubeMusic", () => ({ ytMusicService: {} }));
import {
    loadKnownNativePersonalIds,
    loadOwnedNativePersonalSignals,
} from "../personalNativeCandidates";
import { toNativeRecommendationCandidate } from "../nativeCandidates";

const now = new Date("2026-10-09T10:00:00Z");
function namespace(provider: "vk" | "yandex", id: string) {
    return {
        provider,
        providerTrackId: id,
        verifiedMetadata: {
            provider,
            id,
            title: `Song ${id}`,
            artists: [`Band ${id}`],
            duration: 180,
            preview: false,
            contentVersion: "unknown",
        },
        metadataObservedAt: now,
        metadataConnectionVersion: 1,
    };
}
beforeEach(() => {
    jest.clearAllMocks();
    mockLikes.mockResolvedValue([]);
    mockPlays.mockResolvedValue([]);
    mockNamespaces.mockResolvedValue([]);
});

describe("owned native listening signals", () => {
    it("admits only coherent owner evidence and keeps failed starts out of taste and novelty", async () => {
        const like = {
            userId: "owner-a",
            likedAt: now,
            trackMusicSource: namespace("vk", "-01_0002"),
        };
        mockLikes.mockResolvedValue([
            like,
            like,
            { ...like, userId: "owner-b" },
            { ...like, likedAt: new Date(now.getTime() + 1) },
            { ...like, likedAt: new Date(NaN) },
            {
                ...like,
                trackMusicSource: {
                    ...like.trackMusicSource,
                    metadataConnectionVersion: 0,
                },
            },
        ]);
        const play = {
            userId: "owner-a",
            source: "YANDEX",
            playedAt: now,
            outcome: "completed",
            listenedSeconds: 180,
            completionRatio: 1,
            trackMusicSource: namespace("yandex", "0002"),
            // A private display snapshot must never become shared recording facts.
            title: "Unverified title",
            artist: "Unverified artist",
        };
        mockPlays.mockResolvedValue([
            play,
            {
                ...play,
                trackMusicSource: namespace("yandex", "3"),
                outcome: "meaningful",
                completionRatio: 0.5,
            },
            {
                ...play,
                trackMusicSource: namespace("yandex", "4"),
                outcome: "failed",
            },
            {
                ...play,
                trackMusicSource: namespace("yandex", "5"),
                outcome: "skipped",
                listenedSeconds: 5,
                completionRatio: 0.03,
            },
            {
                ...play,
                trackMusicSource: namespace("yandex", "6"),
                outcome: null,
                listenedSeconds: 4,
                completionRatio: null,
            },
            { ...play, userId: "owner-b" },
            { ...play, source: "VK" },
            { ...play, playedAt: new Date(now.getTime() + 1) },
            { ...play, playedAt: new Date(NaN) },
            {
                ...play,
                trackMusicSource: {
                    ...play.trackMusicSource,
                    providerTrackId: "other",
                },
            },
        ]);
        const result = await loadOwnedNativePersonalSignals("owner-a", now);
        expect(result.liked.map((track) => track.id)).toEqual(["vk:-01_0002"]);
        expect(result.recent.map((track) => track.id)).toEqual([
            "yandex:0002",
            "yandex:3",
        ]);
        expect([...result.knownIds]).toEqual([
            "vk:-01_0002",
            "yandex:0002",
            "yandex:3",
            "yandex:5",
            "yandex:6",
        ]);
        expect(result.plays).toHaveLength(5);
        expect(result.recent[0]).toMatchObject({
            title: "Song 0002",
            artist: { name: "Band 0002" },
        });
        expect(mockLikes.mock.calls[0][0].where).toMatchObject({
            userId: "owner-a",
            likedAt: { lte: now },
        });
        expect(mockPlays.mock.calls[0][0].where).toMatchObject({
            userId: "owner-a",
            playedAt: { lte: now },
        });
    });

    it("finds old exact plays in bounded provider batches without accepting unrelated or unverified rows", async () => {
        const candidates = Array.from(
            { length: 251 },
            (_, index) =>
                toNativeRecommendationCandidate(
                    namespace("yandex", String(index + 1)).verifiedMetadata,
                    "test",
                )!,
        );
        candidates.push(
            toNativeRecommendationCandidate(
                namespace("vk", "-01_0002").verifiedMetadata,
                "test",
            )!,
        );
        mockNamespaces
            .mockResolvedValueOnce([
                namespace("yandex", "1"),
                namespace("yandex", "250"),
                namespace("yandex", "9999"),
                { ...namespace("yandex", "2"), metadataConnectionVersion: 0 },
            ])
            .mockResolvedValueOnce([
                namespace("yandex", "251"),
                namespace("vk", "-01_0002"),
            ]);
        const result = await loadKnownNativePersonalIds(
            "owner-a",
            [...candidates, candidates[0]],
            now,
        );
        expect([...result]).toEqual([
            "yandex:1",
            "yandex:250",
            "yandex:251",
            "vk:-01_0002",
        ]);
        expect(mockNamespaces).toHaveBeenCalledTimes(2);
        const queries = mockNamespaces.mock.calls.map(([query]) => query);
        expect(queries.map((query) => query.take)).toEqual([250, 2]);
        for (const query of queries) {
            for (const group of query.where.OR) {
                expect(group.OR[0].likedTracks.some).toEqual({
                    userId: "owner-a",
                    likedAt: { lte: now },
                });
                expect(group.OR[1].plays.some).toEqual({
                    userId: "owner-a",
                    source: group.provider === "vk" ? "VK" : "YANDEX",
                    playedAt: { lte: now },
                    OR: [{ outcome: null }, { outcome: { not: "failed" } }],
                });
            }
        }
    });

    it("does not return listening signals if the caller is cancelled during its reads", async () => {
        let cancelled = false;
        mockPlays.mockImplementation(async () => {
            cancelled = true;
            return [];
        });
        await expect(
            loadOwnedNativePersonalSignals("owner-a", now, () => {
                if (cancelled) throw new Error("caller cancelled");
            }),
        ).rejects.toThrow("caller cancelled");
    });

    it("returns no known IDs and performs no historical query for an empty candidate set", async () => {
        expect(await loadKnownNativePersonalIds("owner-a", [], now)).toEqual(
            new Set(),
        );
        expect(mockNamespaces).not.toHaveBeenCalled();
    });
});
