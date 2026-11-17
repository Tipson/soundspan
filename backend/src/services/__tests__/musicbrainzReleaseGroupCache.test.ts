interface CacheEntry {
    data: string;
    expiresAt: number | null;
}

const mockCache = new Map<string, CacheEntry>();
const mockHttpGet = jest.fn();
const mockRedisTtl = jest.fn();

function liveEntry(key: string): CacheEntry | undefined {
    const entry = mockCache.get(key);
    if (
        entry?.expiresAt !== null &&
        entry?.expiresAt !== undefined &&
        entry.expiresAt <= Date.now()
    ) {
        mockCache.delete(key);
        return undefined;
    }
    return entry;
}

jest.mock("axios", () => ({
    __esModule: true,
    default: { create: () => ({ get: mockHttpGet }) },
}));
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async (key: string) => liveEntry(key)?.data ?? null),
        ttl: mockRedisTtl,
        setEx: jest.fn(async (key: string, seconds: number, data: string) => {
            mockCache.set(key, {
                data,
                expiresAt: Date.now() + seconds * 1_000,
            });
            return "OK";
        }),
    },
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
    },
}));
jest.mock("../rateLimiter", () => ({
    rateLimiter: {
        execute: async (_bucket: string, request: () => Promise<unknown>) =>
            request(),
    },
}));
jest.mock("../musicbrainzRequestGate", () => ({
    runMusicBrainzRequest: async (request: () => Promise<unknown>) => request(),
}));

import { musicBrainzService } from "../musicbrainz";

const ARTIST_MBID = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
const CACHE_KEY = `mb:rg:${ARTIST_MBID}:album,ep:100`;
const RECOVERED_GROUPS = [
    { id: "6b9a9e04-abd7-4666-86ba-bb220ef4c3b2", title: "Recovered" },
];
const THIRTY_DAYS_SECONDS = 2_592_000;

beforeEach(() => {
    jest.useFakeTimers().setSystemTime(0);
    jest.clearAllMocks();
    mockHttpGet.mockReset();
    mockCache.clear();
    mockRedisTtl.mockReset().mockImplementation(async (key: string) => {
        const entry = liveEntry(key);
        return !entry
            ? -2
            : entry.expiresAt === null
              ? -1
              : Math.ceil((entry.expiresAt - Date.now()) / 1_000);
    });
});
afterEach(() => jest.useRealTimers());

it("expires successful empty artist release groups before the 121-second recovery lookup", async () => {
    mockHttpGet
        .mockResolvedValueOnce({ data: { "release-groups": [] } })
        .mockResolvedValueOnce({
            data: { "release-groups": RECOVERED_GROUPS },
        });

    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual([]);
    expect(mockCache.get(CACHE_KEY)?.expiresAt).toBe(120_000);
    jest.setSystemTime(121_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
        RECOVERED_GROUPS,
    );
    expect(mockHttpGet).toHaveBeenCalledTimes(2);
});

it("honors the short negative entry without extending its deadline on cache hits", async () => {
    mockCache.set(CACHE_KEY, { data: "[]", expiresAt: 120_000 });
    mockHttpGet.mockResolvedValueOnce({
        data: { "release-groups": RECOVERED_GROUPS },
    });

    jest.setSystemTime(50_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual([]);
    jest.setSystemTime(110_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual([]);
    expect(mockHttpGet).not.toHaveBeenCalled();
    expect(mockCache.get(CACHE_KEY)?.expiresAt).toBe(120_000);
    jest.setSystemTime(121_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
        RECOVERED_GROUPS,
    );
});

it.each([THIRTY_DAYS_SECONDS, 121, null])(
    "rechecks legacy empty release groups with remaining lifetime %s",
    async (seconds) => {
        mockCache.set(CACHE_KEY, {
            data: "[]",
            expiresAt: seconds === null ? null : seconds * 1_000,
        });
        mockHttpGet.mockResolvedValueOnce({
            data: { "release-groups": RECOVERED_GROUPS },
        });

        expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
            RECOVERED_GROUPS,
        );
        expect(mockHttpGet).toHaveBeenCalledTimes(1);
    },
);

it("replaces a legacy empty entry with one fixed short deadline when the provider is still empty", async () => {
    mockCache.set(CACHE_KEY, { data: "[]", expiresAt: null });
    mockHttpGet
        .mockResolvedValueOnce({ data: { "release-groups": [] } })
        .mockResolvedValueOnce({
            data: { "release-groups": RECOVERED_GROUPS },
        });
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual([]);
    jest.setSystemTime(60_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual([]);
    expect(mockCache.get(CACHE_KEY)?.expiresAt).toBe(120_000);
    expect(mockHttpGet).toHaveBeenCalledTimes(1);
    jest.setSystemTime(121_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
        RECOVERED_GROUPS,
    );
});

it("retains the thirty-day lifetime for a populated provider result without renewing it on reads", async () => {
    mockHttpGet.mockResolvedValueOnce({
        data: { "release-groups": RECOVERED_GROUPS },
    });
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
        RECOVERED_GROUPS,
    );
    jest.setSystemTime(121_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
        RECOVERED_GROUPS,
    );
    expect(mockCache.get(CACHE_KEY)?.expiresAt).toBe(
        THIRTY_DAYS_SECONDS * 1_000,
    );
    expect(mockHttpGet).toHaveBeenCalledTimes(1);
    expect(mockRedisTtl).not.toHaveBeenCalled();
});

it("keeps existing positive entries until their original expiry instead of extending or bypassing them", async () => {
    const previous = [{ id: "previous", title: "Previous" }];
    mockCache.set(CACHE_KEY, {
        data: JSON.stringify(previous),
        expiresAt: 90_000,
    });
    mockHttpGet.mockResolvedValueOnce({
        data: { "release-groups": RECOVERED_GROUPS },
    });
    jest.setSystemTime(60_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
        previous,
    );
    expect(mockCache.get(CACHE_KEY)?.expiresAt).toBe(90_000);
    expect(mockHttpGet).not.toHaveBeenCalled();
    jest.setSystemTime(91_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
        RECOVERED_GROUPS,
    );
});

it("short-caches provider failures and recovers after the same fixed negative deadline", async () => {
    mockHttpGet
        .mockRejectedValueOnce(new Error("provider unavailable"))
        .mockResolvedValueOnce({
            data: { "release-groups": RECOVERED_GROUPS },
        });
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual([]);
    jest.setSystemTime(60_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual([]);
    expect(mockCache.get(CACHE_KEY)?.expiresAt).toBe(120_000);
    jest.setSystemTime(121_000);
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
        RECOVERED_GROUPS,
    );
});

it("preserves release-group 404 control flow without creating a fallback cache entry", async () => {
    const error = Object.assign(new Error("not found"), {
        response: { status: 404 },
    });
    mockHttpGet.mockRejectedValueOnce(error);
    await expect(musicBrainzService.getReleaseGroups(ARTIST_MBID)).rejects.toBe(
        error,
    );
    expect(mockCache.has(CACHE_KEY)).toBe(false);
});

it("refetches when a cached negative expires between GET and TTL", async () => {
    mockCache.set(CACHE_KEY, { data: "[]", expiresAt: 120_000 });
    mockRedisTtl.mockResolvedValueOnce(-2);
    mockHttpGet.mockResolvedValueOnce({
        data: { "release-groups": RECOVERED_GROUPS },
    });
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
        RECOVERED_GROUPS,
    );
});

it("serves recovered provider data when Redis TTL introspection fails", async () => {
    mockCache.set(CACHE_KEY, { data: "[]", expiresAt: 120_000 });
    mockRedisTtl.mockRejectedValueOnce(new Error("Redis unavailable"));
    mockHttpGet.mockResolvedValueOnce({
        data: { "release-groups": RECOVERED_GROUPS },
    });
    expect(await musicBrainzService.getReleaseGroups(ARTIST_MBID)).toEqual(
        RECOVERED_GROUPS,
    );
});

it("preserves successful empty search and credit-browse caches without opting them into discography policy", async () => {
    mockHttpGet
        .mockResolvedValueOnce({ data: { artists: [] } })
        .mockResolvedValueOnce({ data: { "release-groups": [] } });
    expect(await musicBrainzService.searchArtist("Missing")).toEqual([]);
    expect(
        await musicBrainzService.getReleaseGroupsWithCredits(ARTIST_MBID),
    ).toEqual([]);
    jest.setSystemTime(121_000);
    expect(await musicBrainzService.searchArtist("Missing")).toEqual([]);
    expect(
        await musicBrainzService.getReleaseGroupsWithCredits(ARTIST_MBID),
    ).toEqual([]);
    expect(mockCache.get("mb:search:artist:Missing:10")?.expiresAt).toBe(
        THIRTY_DAYS_SECONDS * 1_000,
    );
    expect(
        mockCache.get(`mb:rg:credits2:${ARTIST_MBID}:album,ep:100`)?.expiresAt,
    ).toBe(THIRTY_DAYS_SECONDS * 1_000);
    expect(mockRedisTtl).not.toHaveBeenCalled();
    expect(mockHttpGet).toHaveBeenCalledTimes(2);
});
