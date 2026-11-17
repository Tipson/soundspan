const findMany = jest.fn();
jest.mock("../../utils/db", () => ({
    prisma: { likedRemoteTrack: { findMany } },
}));

import { searchLikedRemoteTracks } from "../likedRemoteSearch";

const likedAt = new Date("2026-11-17T12:00:00Z");
function native(id = "-12_34", provider = "vk") {
    return {
        provider,
        providerTrackId: id,
        metadataObservedAt: new Date("2026-11-16T12:00:00Z"),
        metadataConnectionVersion: 7,
        verifiedMetadata: {
            provider,
            id,
            title: "Needle",
            artists: ["Artist", "Guest"],
            duration: 180,
            contentVersion: "clean",
            preview: false,
        },
    };
}
function row(id: string, namespace = native()) {
    return { id, likedAt, trackMusicSource: namespace, trackYtMusic: null };
}

beforeEach(() => {
    jest.resetAllMocks();
    findMany.mockResolvedValue([]);
});

it("reads only the owner liked rows with stable bounded database pagination", async () => {
    findMany.mockResolvedValue([
        row("a"),
        row("b", native("123", "yandex")),
        row("c"),
    ]);
    const result = await searchLikedRemoteTracks({
        userId: "owner-a",
        query: "Needle",
        offset: 4,
        limit: 2,
    });
    expect(result.streamingTracks.map((track) => track.id)).toEqual([
        "vk:-12_34",
        "yandex:123",
    ]);
    expect(result.streamingTracks[0]).toMatchObject({
        source: "vk",
        streamSource: "vk",
        likedAt: likedAt.toISOString(),
        album: { id: null },
        artist: { id: null },
        musicSourceRecording: { artists: ["Artist", "Guest"] },
    });
    expect(result.streamingPage).toEqual({
        offset: 4,
        limit: 2,
        hasMore: true,
    });
    expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
            where: expect.objectContaining({ userId: "owner-a" }),
            orderBy: [{ likedAt: "desc" }, { id: "asc" }],
            skip: 4,
            take: 3,
        }),
    );
});

it("uses fixed case-insensitive JSON paths for title and all ten credited artists", async () => {
    await searchLikedRemoteTracks({
        userId: "owner-b",
        query: "Guest",
        limit: 10,
        offset: 0,
    });
    const args = findMany.mock.calls[0][0];
    expect(args.where.userId).toBe("owner-b");
    const direct = args.where.OR[1].trackMusicSource;
    expect(direct.provider).toEqual({ in: ["vk", "yandex"] });
    expect(direct.OR).toHaveLength(11);
    expect(direct.OR[0]).toEqual({
        verifiedMetadata: {
            path: ["title"],
            string_contains: "Guest",
            mode: "insensitive",
        },
    });
    expect(direct.OR[10]).toEqual({
        verifiedMetadata: {
            path: ["artists", "9"],
            string_contains: "Guest",
            mode: "insensitive",
        },
    });
    expect(args.where.OR[0]).toEqual({
        trackYtMusic: {
            OR: [
                { title: { contains: "Guest", mode: "insensitive" } },
                { artist: { contains: "Guest", mode: "insensitive" } },
                { album: { contains: "Guest", mode: "insensitive" } },
            ],
        },
    });
    expect(args.select).not.toHaveProperty("user");
    expect(args.select).not.toHaveProperty("trackTidal");
});

it.each([
    ["100%", "100\\%"],
    ["under_score", "under\\_score"],
    ["a\\b", "a\\\\b"],
])("binds literal LIKE characters for %s", async (query, escaped) => {
    await searchLikedRemoteTracks({
        userId: "owner-a",
        query,
        limit: 1,
        offset: 0,
    });
    const branches = findMany.mock.calls[0][0].where.OR;
    expect(branches[0].trackYtMusic.OR[0].title.contains).toBe(escaped);
    expect(
        branches[1].trackMusicSource.OR[0].verifiedMetadata.string_contains,
    ).toBe(escaped);
});

it("reuses the existing YouTube liked DTO without a provider lookup", async () => {
    findMany.mockResolvedValue([
        {
            id: "yt-like",
            likedAt,
            trackMusicSource: null,
            trackYtMusic: {
                id: "yt-row",
                videoId: "abcdefghijk",
                title: "Needle",
                artist: "Artist",
                album: "Album",
                duration: 180,
                artistId: null,
                albumId: null,
                thumbnailUrl: null,
            },
        },
    ]);
    const result = await searchLikedRemoteTracks({
        userId: "owner-a",
        query: "Album",
        limit: 10,
        offset: 0,
    });
    expect(result.streamingTracks[0]).toMatchObject({
        id: "yt:abcdefghijk",
        source: "youtube",
        streamSource: "youtube",
        youtubeVideoId: "abcdefghijk",
        provider: { youtubeVideoId: "abcdefghijk" },
        album: { id: null, title: "Album" },
    });
});

it.each(["unattested", "wrong-id", "wrong-provider", "bad-artist"])(
    "drops %s native metadata after consuming its raw page",
    async (variant) => {
        const namespace = native();
        if (variant === "unattested") namespace.metadataConnectionVersion = 0;
        if (variant === "wrong-id") namespace.verifiedMetadata.id = "-12_99";
        if (variant === "wrong-provider") namespace.provider = "yandex";
        if (variant === "bad-artist") namespace.verifiedMetadata.artists = [];
        findMany.mockResolvedValue([row("bad", namespace), row("next")]);
        const result = await searchLikedRemoteTracks({
            userId: "owner-a",
            query: "Needle",
            limit: 1,
            offset: 0,
        });
        expect(result).toEqual({
            streamingTracks: [],
            streamingPage: { offset: 0, limit: 1, hasMore: true },
        });
    },
);

it("does not read the database for an empty query or absent owner", async () => {
    for (const input of [
        { userId: "owner-a", query: "   " },
        { userId: "", query: "Needle" },
    ]) {
        expect(
            await searchLikedRemoteTracks({ ...input, limit: 10, offset: 0 }),
        ).toEqual({
            streamingTracks: [],
            streamingPage: { offset: 0, limit: 10, hasMore: false },
        });
    }
    expect(findMany).not.toHaveBeenCalled();
});

it("propagates a database failure to the route availability boundary", async () => {
    findMany.mockRejectedValue(new Error("storage unavailable"));
    await expect(
        searchLikedRemoteTracks({
            userId: "owner-a",
            query: "Needle",
            limit: 10,
            offset: 0,
        }),
    ).rejects.toThrow("storage unavailable");
});
