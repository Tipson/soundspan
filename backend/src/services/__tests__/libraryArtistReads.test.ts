const prisma = {
    artist: { findFirst: jest.fn() },
};

jest.mock("../../utils/db", () => ({ prisma }));

import { readLibraryArtist } from "../libraryArtistReads";

describe("library artist reads", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.artist.findFirst.mockResolvedValue(null);
    });

    it("builds a strict visible artist slice with complete album tracks", async () => {
        await readLibraryArtist({
            lookup: { id: "artist-1" },
            albumLocations: ["LIBRARY", "FEDERATED"],
            requireVisibleAlbum: true,
            albumOrder: "year-title",
        });

        expect(prisma.artist.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: "artist-1",
                    albums: {
                        some: expect.objectContaining({
                            location: { in: ["LIBRARY", "FEDERATED"] },
                        }),
                    },
                },
                include: expect.objectContaining({
                    albums: expect.objectContaining({
                        where: expect.objectContaining({
                            location: { in: ["LIBRARY", "FEDERATED"] },
                        }),
                        orderBy: [{ year: "desc" }, { title: "asc" }],
                        include: expect.objectContaining({
                            tracks: expect.not.objectContaining({
                                take: expect.anything(),
                            }),
                        }),
                    }),
                }),
            }),
        );
    });

    it("preserves flexible library lookup and the per-album track cap", async () => {
        await readLibraryArtist({
            lookup: {
                id: "route-value",
                name: "decoded name",
                mbid: "route-value",
            },
            albumLocations: ["LIBRARY", "DISCOVER", "REMOTE", "FEDERATED"],
            requireVisibleAlbum: false,
            albumOrder: "year",
            maxTracksPerAlbum: 10,
        });

        const args = prisma.artist.findFirst.mock.calls[0][0];
        expect(args.where).toEqual({
            OR: [
                { id: "route-value" },
                { name: { equals: "decoded name", mode: "insensitive" } },
                { mbid: "route-value" },
            ],
        });
        expect(args.include.albums.include.tracks.take).toBe(10);
        expect(args.include.albums.orderBy).toEqual([{ year: "desc" }]);
    });

    it("reads existing REMOTE YT albums only for the requesting liked owner", async () => {
        const matches = (row: any, filter: any): boolean => {
            if (filter === null || typeof filter !== "object")
                return row === filter;
            return Object.entries(filter).every(
                ([key, value]: [string, any]) => {
                    if (key === "OR")
                        return value.some((part: any) => matches(row, part));
                    if (key === "AND")
                        return value.every((part: any) => matches(row, part));
                    if (key === "some")
                        return (
                            Array.isArray(row) &&
                            row.some((part) => matches(part, value))
                        );
                    if (key === "in") return value.includes(row);
                    return matches(row?.[key], value);
                },
            );
        };
        const albums = ["owner-a", "owner-b"].map((userId) => ({
            id: userId + "-remote",
            location: "REMOTE",
            tracks: [],
            tracksYtMusic: [{ id: userId + "-yt", likedBy: [{ userId }] }],
        }));
        prisma.artist.findFirst.mockImplementation(async (args) => ({
            id: "artist",
            albums: albums.filter((row) =>
                matches(row, args.include.albums.where),
            ),
        }));
        for (const owner of ["owner-a", "owner-b"]) {
            const options = {
                lookup: { id: "artist" },
                albumLocations: ["LIBRARY", "REMOTE"] as const,
                requireVisibleAlbum: false,
                albumOrder: "year" as const,
                likedRemoteAlbumsUserId: owner,
            };
            const result = await readLibraryArtist(options);
            expect(result?.albums.map((row: any) => row.id)).toEqual([
                owner + "-remote",
            ]);
            const args = prisma.artist.findFirst.mock.calls.at(-1)![0];
            expect(args.include.albums.include.tracksYtMusic.where).toEqual({
                likedBy: { some: { userId: owner } },
            });
        }
    });
});
