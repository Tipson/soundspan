import {
    getHandler,
    createRes,
    prisma,
    mockLikedTrackCount,
    mockLikedTrackFindMany,
    mockRemoteLikedTrackCount,
    mockRemoteLikedTrackFindMany,
    mockUserSettingsFindUnique,
    mockTrackMappingFindMany,
} from "./libraryRuntime.helpers";

const handler = getHandler("get", "/liked");
const likedAt = new Date("2026-10-08T09:00:00Z");
function entry(id: string, provider: "vk" | "yandex", nativeId: string) {
    return {
        id,
        userId: "owner-a",
        likedAt,
        trackYtMusicId: null,
        trackTidalId: null,
        trackMusicSourceId: `namespace-${id}`,
        trackYtMusic: null,
        trackTidal: null,
        trackMusicSource: {
            id: `namespace-${id}`,
            provider,
            providerTrackId: nativeId,
            metadataObservedAt: new Date("2026-10-08T08:00:00Z"),
            metadataConnectionVersion: 7,
            verifiedMetadata: {
                provider,
                id: nativeId,
                title: `Song ${id}`,
                artists: ["Artist", "Guest"],
                duration: 180,
                contentVersion: "clean",
                preview: false,
            },
        },
    };
}
async function load(query: Record<string, string> = {}) {
    const res = createRes();
    await handler({ user: { id: "owner-a" }, query } as any, res);
    expect(res.statusCode).toBe(200);
    return res.body;
}
describe("verified direct tracks in the owner liked playlist", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockLikedTrackCount.mockResolvedValue(0);
        mockLikedTrackFindMany.mockResolvedValue([]);
        mockRemoteLikedTrackCount.mockResolvedValue(2);
        mockRemoteLikedTrackFindMany.mockResolvedValue([
            entry("a", "vk", "-1_2"),
            entry("b", "yandex", "0007"),
        ]);
        mockUserSettingsFindUnique.mockResolvedValue(null);
        mockTrackMappingFindMany.mockResolvedValue([]);
        (prisma.systemSettings.findUnique as jest.Mock).mockResolvedValue(null);
    });
    it("returns exact, complete recordings without a connected credential or fabricated catalog IDs", async () => {
        const body = await load();
        expect(body.total).toBe(2);
        expect(body.tracks.map((track: any) => track.id)).toEqual([
            "vk:-1_2",
            "yandex:0007",
        ]);
        expect(body.tracks[0]).toMatchObject({
            source: "vk",
            mediaSource: "vk",
            streamSource: "vk",
            filePath: null,
            provider: {
                source: "vk",
                providerTrackId: "-1_2",
                youtubeVideoId: null,
                tidalTrackId: null,
            },
            artist: { id: null, name: "Artist, Guest" },
            album: { id: null, title: "", coverArt: null },
            likedAt: likedAt.toISOString(),
            musicSourceRecording: {
                artists: ["Artist", "Guest"],
                contentVersion: "clean",
                duration: 180,
            },
        });
        expect(body.tracks[0]).not.toHaveProperty("youtubeVideoId");
        expect(mockTrackMappingFindMany).not.toHaveBeenCalled();
    });
    it("keeps the supported-source predicate when applying a remote cursor", async () => {
        await load({
            limit: "1",
            cursorLikedAt: likedAt.toISOString(),
            cursorTrackId: "remote:a",
        });
        const args = mockRemoteLikedTrackFindMany.mock.calls[0][0];
        expect(args.where).toMatchObject({
            userId: "owner-a",
            AND: [
                {
                    OR: [
                        { trackYtMusicId: { not: null } },
                        { trackMusicSourceId: { not: null } },
                    ],
                },
            ],
            OR: [{ likedAt: { lt: likedAt } }, { likedAt, id: { gt: "a" } }],
        });
        expect(args.include.trackMusicSource).toBe(true);
        expect(mockRemoteLikedTrackCount.mock.calls[0][0].where.AND).toEqual(
            args.where.AND,
        );
    });
    it("uses the existing remote row cursor across direct sources without duplicates", async () => {
        const rows = [
            entry("a", "vk", "-1_2"),
            entry("b", "yandex", "7"),
            entry("c", "vk", "-1_3"),
        ];
        mockRemoteLikedTrackFindMany.mockImplementation(
            async ({ where, take }: any) => {
                const after = where.OR?.[1]?.id?.gt;
                return rows
                    .filter((row) => !after || row.id > after)
                    .slice(0, take);
            },
        );
        const first = await load({ limit: "1" });
        expect(first.pagination).toMatchObject({
            hasMore: true,
            nextCursor: { trackId: "remote:a" },
        });
        const second = await load({
            limit: "1",
            cursorLikedAt: first.pagination.nextCursor.likedAt,
            cursorTrackId: "remote:a",
        });
        const third = await load({
            limit: "1",
            cursorLikedAt: second.pagination.nextCursor.likedAt,
            cursorTrackId: "remote:b",
        });
        expect(
            [...first.tracks, ...second.tracks, ...third.tracks].map(
                (track) => track.id,
            ),
        ).toEqual(["vk:-1_2", "yandex:7", "vk:-1_3"]);
        expect(third.pagination.hasMore).toBe(false);
    });
    it.each(["unattested", "wrong-provider", "wrong-id", "blank-artist"])(
        "excludes %s metadata instead of trusting a display claim",
        async (variant) => {
            const row = entry("a", "vk", "-1_2");
            if (variant === "unattested")
                row.trackMusicSource.metadataConnectionVersion = 0;
            if (variant === "wrong-provider")
                row.trackMusicSource.provider = "yandex";
            if (variant === "wrong-id")
                row.trackMusicSource.verifiedMetadata.id = "-1_9";
            if (variant === "blank-artist")
                row.trackMusicSource.verifiedMetadata.artists = [" "];
            mockRemoteLikedTrackFindMany.mockResolvedValue([row]);
            expect((await load()).tracks).toEqual([]);
        },
    );
});
