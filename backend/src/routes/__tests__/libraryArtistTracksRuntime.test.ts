import {
    createRes,
    getHandler,
    mockArtistFindFirst,
    mockTrackCount,
    mockTrackFindMany,
} from "./libraryRuntime.helpers";

describe("library artist tracks runtime", () => {
    const artistTracksHandler = getHandler("get", "/artists/:id/tracks");

    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistFindFirst.mockReset();
        mockTrackFindMany.mockReset();
        mockTrackCount.mockReset();
    });

    it("returns one deterministic paginated artist-track page without album fan-out", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({ id: "artist-1" });
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "track-2",
                title: "Second Track",
                duration: 202,
                origin: "LOCAL",
                filePath: "/music/artist/album/02.flac",
                federationPeer: null,
                album: {
                    id: "album-1",
                    title: "Album One",
                    year: 2024,
                    coverUrl: "cover.jpg",
                    artist: { id: "artist-1", name: "Artist One" },
                },
            },
        ]);
        mockTrackCount.mockResolvedValueOnce(3);
        const req = {
            params: { id: "artist-1" },
            query: { limit: "2", offset: "1" },
        } as any;
        const res = createRes();

        await artistTracksHandler(req, res);

        expect(mockTrackFindMany).toHaveBeenCalledTimes(1);
        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                skip: 1,
                take: 2,
                include: {
                    album: {
                        include: {
                            artist: { select: { id: true, name: true } },
                        },
                    },
                    federationPeer: {
                        select: {
                            id: true,
                            name: true,
                            outboundStatus: true,
                        },
                    },
                },
            }),
        );
        expect(mockTrackCount).toHaveBeenCalledTimes(1);
        expect(res.body).toEqual({
            tracks: [
                expect.objectContaining({
                    id: "track-2",
                    source: "local",
                    artist: { id: "artist-1", name: "Artist One" },
                    album: expect.objectContaining({
                        id: "album-1",
                        coverArt: "cover.jpg",
                    }),
                }),
            ],
            total: 3,
            offset: 1,
            limit: 2,
        });
    });

    it("bounds pagination before issuing the artist track query", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({ id: "artist-1" });
        mockTrackFindMany.mockResolvedValueOnce([]);
        mockTrackCount.mockResolvedValueOnce(0);
        const req = {
            params: { id: "artist-1" },
            query: { limit: "9999", offset: "-20" },
        } as any;
        const res = createRes();

        await artistTracksHandler(req, res);

        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({ skip: 0, take: 200 }),
        );
        expect(res.body).toEqual({
            tracks: [],
            total: 0,
            offset: 0,
            limit: 200,
        });
    });

    it("returns 404 without querying tracks", async () => {
        mockArtistFindFirst.mockResolvedValueOnce(null);
        const req = {
            params: { id: "missing" },
            query: { limit: "9999", offset: "-20" },
        } as any;
        const res = createRes();

        await artistTracksHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Artist not found" });
        expect(mockTrackFindMany).not.toHaveBeenCalled();
        expect(mockTrackCount).not.toHaveBeenCalled();
    });
});
