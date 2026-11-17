const mockFindMany = jest.fn(),
    mockUpdateMany = jest.fn(),
    mockSearch = jest.fn(),
    mockQueryRaw = jest.fn(),
    mockTransaction = jest.fn();
const mockTx = {
    album: { updateMany: mockUpdateMany },
    $queryRaw: mockQueryRaw,
};
jest.mock("../../utils/db", () => ({
    prisma: {
        album: { findMany: mockFindMany, updateMany: mockUpdateMany },
        $transaction: mockTransaction,
    },
}));
jest.mock("../musicbrainz", () => ({
    musicBrainzService: { searchReleaseGroupsForAlbumIdentity: mockSearch },
}));
jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ debug: jest.fn() }) },
}));
import {
    albumMatchInputHash,
    resolveRemoteAlbumMbids,
} from "../remoteAlbumMbidResolution";

const now = new Date("2026-11-17T12:00:00Z"),
    rg = "11111111-1111-4111-8111-111111111111",
    artistMbid = "22222222-2222-4222-8222-222222222222";
const album = (extra = {}) => ({
    id: "remote-a",
    rgMbid: "remote:fixture",
    title: "Album",
    artistId: "artist-a",
    artist: { name: "Artist", mbid: artistMbid },
    location: "REMOTE",
    matchedRgMbid: null,
    rgMbidCheckedAt: null,
    rgMbidMatchInputHash: null,
    tracksYtMusic: [{ title: "Song" }],
    ...extra,
});
const groups = (extra = {}) => [
    {
        id: rg,
        title: "Album",
        "primary-type": "Album",
        "artist-credit": [{ artist: { id: artistMbid, name: "Artist" } }],
        score: 100,
        ...extra,
    },
];

describe("bounded REMOTE release-group resolution", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindMany.mockResolvedValue([album()]);
        mockUpdateMany.mockResolvedValue({ count: 1 });
        mockSearch.mockResolvedValue(groups());
        mockQueryRaw.mockResolvedValue([]);
        mockTransaction.mockImplementation(
            async (callback: (tx: typeof mockTx) => Promise<unknown>) =>
                callback(mockTx),
        );
    });
    it("writes only sidecar fields and fences the observed source state", async () => {
        expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
            scanned: 1,
            matched: 1,
        });
        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: "remote-a",
                rgMbid: "remote:fixture",
                title: "Album",
                artistId: "artist-a",
                location: "REMOTE",
                matchedRgMbid: null,
                rgMbidCheckedAt: null,
                artist: { name: "Artist", mbid: artistMbid },
            }),
            data: {
                matchedRgMbid: rg,
                rgMbidCheckedAt: now,
                rgMbidMatchInputHash: albumMatchInputHash(album()),
            },
        });
        expect(mockFindMany.mock.calls[0][0]).toMatchObject({
            take: 25,
            where: {
                location: "REMOTE",
                rgMbid: { startsWith: "remote:" },
                tracksYtMusic: { some: { likedBy: { some: {} } } },
            },
        });
    });
    it("does not claim a match if source changed while lookup was pending", async () => {
        mockUpdateMany.mockResolvedValueOnce({ count: 0 });
        expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
            matched: 0,
            skipped: 1,
        });
    });
    it("uses a genuine miss as one-hour negative and clears only the previous match", async () => {
        mockFindMany.mockResolvedValueOnce([
            album({
                matchedRgMbid: rg,
                rgMbidCheckedAt: new Date(now.getTime() - 31 * 86400000),
            }),
        ]);
        mockSearch.mockResolvedValueOnce([]);
        expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
            missed: 1,
        });
        expect(mockUpdateMany.mock.calls[0][0].data).toMatchObject({
            matchedRgMbid: null,
            rgMbidCheckedAt: now,
        });
        mockFindMany.mockResolvedValueOnce([
            album({
                rgMbidCheckedAt: new Date(now.getTime() - 3599999),
                rgMbidMatchInputHash: albumMatchInputHash(album()),
            }),
        ]);
        mockSearch.mockClear();
        expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
            skipped: 1,
        });
        expect(mockSearch).not.toHaveBeenCalled();
    });
    it("rechecks a negative exactly at TTL expiry and an altered input immediately when loaded", async () => {
        mockFindMany.mockResolvedValueOnce([
            album({
                rgMbidCheckedAt: new Date(now.getTime() - 3600000),
                rgMbidMatchInputHash: albumMatchInputHash(album()),
            }),
        ]);
        await resolveRemoteAlbumMbids({ now });
        expect(mockSearch).toHaveBeenCalledTimes(1);
        mockFindMany.mockResolvedValueOnce([
            album({
                title: "Changed",
                rgMbidCheckedAt: now,
                rgMbidMatchInputHash: albumMatchInputHash(album()),
            }),
        ]);
        await resolveRemoteAlbumMbids({ now });
        expect(mockSearch).toHaveBeenCalledTimes(2);
    });
    it("rejects wrong artist credits and distinct RG ambiguity", async () => {
        mockSearch.mockResolvedValueOnce(
            groups({
                "artist-credit": [{ artist: { id: rg, name: "Artist" } }],
            }),
        );
        expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
            missed: 1,
        });
        mockSearch.mockResolvedValueOnce([
            ...groups(),
            ...groups({ id: "33333333-3333-4333-8333-333333333333" }),
        ]);
        expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
            missed: 1,
        });
    });
    it("uses exact normalized artist credit when no real artist MBID exists", async () => {
        mockFindMany.mockResolvedValueOnce([
            album({ artist: { name: "Artist", mbid: "remote:artist" } }),
        ]);
        mockSearch.mockResolvedValueOnce(
            groups({
                "artist-credit": [{ artist: { name: "Artist Tribute Band" } }],
            }),
        );
        expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
            missed: 1,
        });
    });
    it("does not poison negative state or destroy a match on 503/malformed response", async () => {
        for (const error of [
            { response: { status: 503 } },
            new TypeError("malformed"),
        ]) {
            mockSearch.mockRejectedValueOnce(error);
            expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
                errors: 1,
            });
        }
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });
    it("stops after three consecutive failures and enforces configured batch bounds", async () => {
        mockFindMany.mockResolvedValue(
            Array.from({ length: 25 }, (_, n) => album({ id: "a" + n })),
        );
        mockSearch.mockRejectedValue(new Error("503"));
        expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
            scanned: 3,
            errors: 3,
        });
        expect(mockSearch).toHaveBeenCalledTimes(3);
        for (const batchSize of [0, 26, 1.1])
            await expect(
                resolveRemoteAlbumMbids({ batchSize, now }),
            ).rejects.toThrow(RangeError);
    });
    it("keeps a timed-out lookup slot occupied and ignores its late result", async () => {
        jest.useFakeTimers({ now });
        let finish!: (rows: ReturnType<typeof groups>) => void;
        const work = new Promise<ReturnType<typeof groups>>((resolve) => {
            finish = resolve;
        });
        mockSearch.mockReturnValueOnce(work);
        try {
            const result = resolveRemoteAlbumMbids({ now });
            await jest.advanceTimersByTimeAsync(15000);
            expect(await result).toMatchObject({ scanned: 1, errors: 1 });
            expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
                scanned: 0,
                skipped: 1,
            });
            finish(groups());
            await work;
            await Promise.resolve();
            expect(mockUpdateMany).not.toHaveBeenCalled();
        } finally {
            finish(groups());
            await work;
            jest.useRealTimers();
        }
    });
    it("does not persist a result returned after the whole-run deadline", async () => {
        let clock = 0;
        const readClock = jest
            .spyOn(Date, "now")
            .mockImplementation(() => clock);
        mockFindMany.mockResolvedValueOnce([
            album(),
            album({ id: "second" }),
            album({ id: "third" }),
        ]);
        mockSearch.mockImplementation(async () => {
            clock += 31000;
            return groups();
        });
        try {
            expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
                scanned: 2,
                matched: 1,
                skipped: 1,
            });
            expect(mockUpdateMany).toHaveBeenCalledTimes(1);
        } finally {
            readClock.mockRestore();
        }
    });

    it("rolls back a CAS that finishes after its admitted deadline", async () => {
        let clock = 0,
            committed = 0,
            rolledBack = 0;
        const readClock = jest
            .spyOn(Date, "now")
            .mockImplementation(() => clock);
        mockTransaction.mockImplementationOnce(
            async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
                try {
                    const value = await callback(mockTx);
                    committed++;
                    return value;
                } catch (error) {
                    rolledBack++;
                    throw error;
                }
            },
        );
        mockUpdateMany.mockImplementationOnce(async () => {
            clock = 61000;
            return { count: 1 };
        });
        try {
            expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
                matched: 0,
                errors: 1,
            });
            expect(committed).toBe(0);
            expect(rolledBack).toBe(1);
            expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), {
                maxWait: 5000,
                timeout: 5000,
            });
            expect(mockQueryRaw.mock.calls[0][0].join("?")).toContain(
                "lock_timeout",
            );
        } finally {
            readClock.mockRestore();
        }
    });

    it("retains the active slot until an expired transaction callback settles", async () => {
        let finish!: (result: { count: number }) => void, started!: () => void;
        const pendingWrite = new Promise<{ count: number }>((resolve) => {
            finish = resolve;
        });
        const updateStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        mockUpdateMany.mockImplementationOnce(() => {
            started();
            return pendingWrite;
        });
        mockTransaction.mockImplementationOnce(
            async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
                void callback(mockTx).catch(() => undefined);
                await updateStarted;
                throw new Error("fixture ITX expired before driver settlement");
            },
        );
        let completed = false;
        const run = resolveRemoteAlbumMbids({ now }).finally(() => {
            completed = true;
        });
        try {
            await updateStarted;
            await Promise.resolve();
            await Promise.resolve();
            expect(await resolveRemoteAlbumMbids({ now })).toMatchObject({
                scanned: 0,
                skipped: 1,
            });
            expect(completed).toBe(false);
            expect(mockTransaction).toHaveBeenCalledTimes(1);
        } finally {
            finish({ count: 1 });
            await run;
        }
    });
});
