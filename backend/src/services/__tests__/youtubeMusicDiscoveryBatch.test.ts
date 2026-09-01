const mockClient = {
    get: jest.fn(),
    post: jest.fn(),
};

jest.mock("../../config", () => ({
    config: {
        internalApiSecret: undefined,
        ytmusicStreamer: { url: "http://127.0.0.1:8586" },
    },
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: jest.fn(() => mockClient),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import { ytMusicService } from "../youtubeMusic";
import { searchYtMusicDiscoveryCatalog } from "../ytMusicDiscoveryCatalog";

const emptyBatchRows = () => [
    { results: [], total: 0, error: null },
    { results: [], total: 0, error: null },
    { results: [], total: 0, error: null },
];

describe("YouTube Music discovery batch", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    it("normalizes tracks, albums, and artists from one bounded batch call", async () => {
        mockClient.post.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        results: [
                            {
                                type: "song",
                                videoId: "teardrop01",
                                title: "Teardrop",
                                artists: [{ name: "Massive Attack" }],
                                album: { name: "Mezzanine" },
                                duration_seconds: 331,
                                thumbnails: [
                                    {
                                        url: "https://img/teardrop.jpg",
                                        width: 544,
                                        height: 544,
                                    },
                                ],
                            },
                            {
                                type: "video",
                                videoId: "longvideo01",
                                title: "Full concert",
                            },
                        ],
                        total: 2,
                        error: null,
                    },
                    {
                        results: [
                            {
                                type: "album",
                                browseId: "MPREb_mezzanine",
                                title: "Mezzanine",
                                artist: "Massive Attack",
                                year: "1998",
                                thumbnails: [],
                            },
                        ],
                        total: 1,
                        error: null,
                    },
                    {
                        results: [
                            {
                                type: "artist",
                                channelId: "UCmassiveattack",
                                artist: "Massive Attack",
                                thumbnails: [],
                            },
                        ],
                        total: 1,
                        error: null,
                    },
                ],
            },
        });

        await expect(
            searchYtMusicDiscoveryCatalog(
                ytMusicService,
                "__public__",
                "massive attack",
                20,
                { timeoutMs: 8_000, maxRetries: 0 },
            ),
        ).resolves.toEqual({
            tracks: [
                expect.objectContaining({
                    providerTrackId: "teardrop01",
                    title: "Teardrop",
                    artistName: "Massive Attack",
                    albumTitle: "Mezzanine",
                }),
            ],
            albums: [
                expect.objectContaining({
                    browseId: "MPREb_mezzanine",
                    title: "Mezzanine",
                }),
            ],
            artists: [
                expect.objectContaining({
                    channelId: "UCmassiveattack",
                    name: "Massive Attack",
                }),
            ],
            failedFilters: [],
        });

        expect(mockClient.post).toHaveBeenCalledTimes(1);
        expect(mockClient.post).toHaveBeenCalledWith(
            "/search/batch",
            {
                queries: [
                    { query: "massive attack", filter: "songs", limit: 20 },
                    { query: "massive attack", filter: "albums", limit: 20 },
                    { query: "massive attack", filter: "artists", limit: 20 },
                ],
            },
            {
                params: { user_id: "__public__" },
                timeout: 8_000,
            },
        );
    });

    it("marks one failed category while retaining successful batch rows", async () => {
        mockClient.post.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        results: [
                            {
                                type: "song",
                                videoId: "numbvideo01",
                                title: "Numb",
                                artist: "Linkin Park",
                            },
                        ],
                        total: 1,
                        error: null,
                    },
                    { results: [], total: 0, error: "search failed" },
                    { results: [], total: 0, error: null },
                ],
            },
        });

        await expect(
            searchYtMusicDiscoveryCatalog(
                ytMusicService,
                "__public__",
                "linkin park",
                20,
                { timeoutMs: 8_000, maxRetries: 0 },
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                tracks: [
                    expect.objectContaining({
                        providerTrackId: "numbvideo01",
                    }),
                ],
                albums: [],
                artists: [],
                failedFilters: ["albums"],
            }),
        );
    });

    it("expands only the songs prefix when loading more track results", async () => {
        mockClient.post.mockResolvedValueOnce({
            data: { results: emptyBatchRows() },
        });

        await searchYtMusicDiscoveryCatalog(
            ytMusicService,
            "__public__",
            "linkin park",
            100,
            { timeoutMs: 8_000, maxRetries: 0 },
        );

        expect(mockClient.post).toHaveBeenCalledWith(
            "/search/batch",
            {
                queries: [
                    { query: "linkin park", filter: "songs", limit: 100 },
                    { query: "linkin park", filter: "albums", limit: 50 },
                    { query: "linkin park", filter: "artists", limit: 50 },
                ],
            },
            expect.any(Object),
        );
    });

    it("keeps two concurrent discovery calls to two batch requests instead of six singles", async () => {
        const releases: Array<() => void> = [];
        mockClient.post.mockImplementation(
            () =>
                new Promise((resolve) => {
                    releases.push(() =>
                        resolve({ data: { results: emptyBatchRows() } }),
                    );
                }),
        );

        const first = searchYtMusicDiscoveryCatalog(
            ytMusicService,
            "__public__",
            "radiohead",
            20,
            { timeoutMs: 8_000, maxRetries: 0 },
        );
        const second = searchYtMusicDiscoveryCatalog(
            ytMusicService,
            "__public__",
            "massive attack",
            20,
            { timeoutMs: 8_000, maxRetries: 0 },
        );

        expect(mockClient.post).toHaveBeenCalledTimes(2);
        expect(mockClient.post).toHaveBeenNthCalledWith(
            1,
            "/search/batch",
            expect.any(Object),
            expect.any(Object),
        );
        expect(mockClient.post).toHaveBeenNthCalledWith(
            2,
            "/search/batch",
            expect.any(Object),
            expect.any(Object),
        );

        releases.forEach((release) => release());
        await expect(Promise.all([first, second])).resolves.toEqual([
            {
                tracks: [],
                albums: [],
                artists: [],
                failedFilters: [],
            },
            {
                tracks: [],
                albums: [],
                artists: [],
                failedFilters: [],
            },
        ]);
    });
});
