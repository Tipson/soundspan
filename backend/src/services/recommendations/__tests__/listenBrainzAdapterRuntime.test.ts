const mockAxiosGet = jest.fn();
const mockAxiosPost = jest.fn();
const mockConnectionFindUnique = jest.fn();
const mockSettingsFindUnique = jest.fn();
const mockDecrypt = jest.fn((value: string) => `decrypted:${value}`);
const mockFindMatchForTrack = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisWithAbortSignal = jest.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: { get: mockAxiosGet, post: mockAxiosPost },
}));
jest.mock("../../../utils/db", () => ({
    prisma: {
        scrobbleConnection: { findUnique: mockConnectionFindUnique },
        userSettings: { findUnique: mockSettingsFindUnique },
    },
}));
jest.mock("../../../utils/encryption", () => ({ decrypt: mockDecrypt }));
jest.mock("../../../utils/redis", () => ({
    redisClient: {
        isReady: true,
        get: mockRedisGet,
        set: mockRedisSet,
        withAbortSignal: mockRedisWithAbortSignal,
    },
}));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));
jest.mock("../../youtubeMusic", () => ({
    ytMusicService: { findMatchForTrack: mockFindMatchForTrack },
}));

import { listenBrainzRecommendationAdapter } from "../listenBrainzAdapter";

function connectedAccount(overrides: Record<string, unknown> = {}) {
    return {
        enabled: true,
        encryptedCredential: "encrypted-token",
        username: "alice name",
        ...overrides,
    };
}

function jspfTrack(overrides: Record<string, unknown> = {}) {
    return {
        identifier: "https://musicbrainz.org/recording/ABCDEF12-1234",
        title: "Song",
        creator: "Artist",
        album: "Album",
        ...overrides,
    };
}

describe("default ListenBrainz runtime dependencies", () => {
    beforeEach(() => {
        mockConnectionFindUnique.mockResolvedValue(connectedAccount());
        mockSettingsFindUnique.mockResolvedValue({
            tasteProfile: { genres: [" rock ", "", 42, "pop"] },
        });
        mockAxiosGet.mockResolvedValue({
            status: 200,
            data: { payload: { mbids: ["ABCDEF12-1234"] } },
        });
        mockAxiosPost.mockResolvedValue({
            data: { playlist: { track: [jspfTrack()] } },
        });
        mockFindMatchForTrack.mockResolvedValue({
            videoId: "video-1",
            title: "Playable Song",
            duration: 181,
        });
        mockRedisGet.mockResolvedValue(null);
        mockRedisSet.mockResolvedValue(undefined);
        mockRedisWithAbortSignal.mockReturnValue({
            get: mockRedisGet,
            set: mockRedisSet,
        });
    });

    it.each([
        null,
        connectedAccount({ enabled: false }),
        connectedAccount({ encryptedCredential: "" }),
        connectedAccount({ username: "" }),
    ])("skips provider work for an unusable connection", async (connection) => {
        mockConnectionFindUnique.mockResolvedValue(connection);

        const result =
            await listenBrainzRecommendationAdapter.getCandidateBatch(
                `missing-${String(connection?.enabled)}-${String(connection?.username)}`,
                10,
                0,
            );

        expect(result).toEqual({ candidates: [], degradedSources: [] });
    });

    it("loads, normalizes and persists collaborative recommendations", async () => {
        const result =
            await listenBrainzRecommendationAdapter.getCandidateBatch(
                "collaborative-user",
                10,
                2,
            );

        expect(mockDecrypt).toHaveBeenCalledWith("encrypted-token");
        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://api.listenbrainz.org/1/cf/recommendation/user/alice%20name/recording",
            expect.objectContaining({
                params: { count: 20, offset: 20 },
                headers: { Authorization: "Token decrypted:encrypted-token" },
            }),
        );
        const validateStatus = mockAxiosGet.mock.calls[0][1].validateStatus;
        expect(validateStatus(200)).toBe(true);
        expect(validateStatus(204)).toBe(true);
        expect(validateStatus(500)).toBe(false);
        expect(result).toEqual({
            candidates: [
                expect.objectContaining({
                    id: "yt:video-1",
                    recordingMbid: "abcdef12-1234",
                    title: "Playable Song",
                    artist: { id: null, name: "Artist" },
                    album: { id: null, title: "Album", coverArt: null },
                    candidateSources: ["listenbrainz-cf"],
                }),
            ],
            degradedSources: [],
        });
        expect(mockFindMatchForTrack).toHaveBeenCalledWith(
            "collaborative-user",
            "Artist",
            "Song",
            "Album",
            undefined,
            undefined,
            expect.objectContaining({ maxRetries: 0 }),
        );
        expect(mockRedisSet).toHaveBeenCalledWith(
            "recommendations:listenbrainz:last-good:collaborative-user",
            expect.stringContaining("video-1"),
            { EX: 21_600 },
        );
    });

    it("normalizes mixed collaborative identifiers and ignores invalid values", async () => {
        mockAxiosGet.mockResolvedValue({
            status: 200,
            data: {
                payload: {
                    mbids: [
                        " FIRST-MBID ",
                        { recording_mbid: " SECOND-MBID " },
                        { mbid: " THIRD-MBID " },
                        { other: "ignored" },
                        42,
                    ],
                },
            },
        });
        mockAxiosPost.mockResolvedValue({ data: { playlist: { track: [] } } });

        await listenBrainzRecommendationAdapter.getCandidateBatch(
            "mixed-mbids-user",
            50,
            -2,
        );

        expect(mockAxiosPost).toHaveBeenCalledWith(
            "https://api.listenbrainz.org/1/player",
            null,
            expect.objectContaining({
                params: {
                    recording_mbids: "first-mbid,second-mbid,third-mbid",
                },
            }),
        );
    });

    it.each([
        [{ selectedGenres: [" jazz "] }, "jazz"],
        [{ tags: [" ambient "] }, "ambient"],
    ])("falls back to tag radio for %j", async (tasteProfile, expectedTag) => {
        mockSettingsFindUnique.mockResolvedValue({ tasteProfile });
        mockAxiosGet
            .mockResolvedValueOnce({ status: 204, data: null })
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    payload: {
                        jspf: { playlist: { track: [jspfTrack()] } },
                    },
                },
            });

        const result =
            await listenBrainzRecommendationAdapter.getCandidateBatch(
                `tag-${expectedTag}`,
                4,
                0,
            );

        expect(mockAxiosGet).toHaveBeenNthCalledWith(
            2,
            "https://api.listenbrainz.org/1/lb-radio/tags",
            expect.objectContaining({ params: { tag: expectedTag, count: 8 } }),
        );
        expect(result.candidates[0]).toEqual(
            expect.objectContaining({
                candidateSources: ["listenbrainz-radio"],
            }),
        );
    });

    it.each([null, [], "invalid", { genres: "rock" }])(
        "returns no tag radio for an invalid taste profile",
        async (tasteProfile) => {
            mockSettingsFindUnique.mockResolvedValue({ tasteProfile });
            mockAxiosGet.mockResolvedValue({
                status: 200,
                data: { payload: { mbids: [] } },
            });

            const result =
                await listenBrainzRecommendationAdapter.getCandidateBatch(
                    `invalid-taste-${JSON.stringify(tasteProfile)}`,
                    4,
                    0,
                );

            expect(result).toEqual({ candidates: [], degradedSources: [] });
            expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        },
    );

    it("parses JSPF fallbacks and drops incomplete rows", async () => {
        mockAxiosPost.mockResolvedValue({
            data: {
                jspf: {
                    playlist: {
                        track: [
                            null,
                            "invalid",
                            jspfTrack({
                                identifier: [
                                    42,
                                    "urn:musicbrainz:recording:DEADBEEF-1234",
                                ],
                                title: undefined,
                                track_name: "Fallback title",
                                creator: undefined,
                                artist_name: "Fallback artist",
                                album: undefined,
                                release_name: "Fallback album",
                            }),
                            jspfTrack({
                                identifier: "invalid",
                                recording_mbid: "DIRECT-MBID",
                                creator: undefined,
                                artist: "Direct artist",
                                album: "",
                            }),
                            jspfTrack({
                                identifier: "invalid",
                                recording_mbid: "",
                            }),
                            jspfTrack({ title: "", track_name: "" }),
                            jspfTrack({
                                creator: "",
                                artist_name: "",
                                artist: "",
                            }),
                        ],
                    },
                },
            },
        });
        mockFindMatchForTrack
            .mockResolvedValueOnce({
                videoId: "fallback-video",
                title: "",
                duration: 180,
            })
            .mockResolvedValueOnce({
                videoId: "direct-video",
                title: "Direct title",
                duration: 190,
            });

        const result =
            await listenBrainzRecommendationAdapter.getCandidateBatch(
                "jspf-fallback-user",
                10,
                0,
            );

        expect(result.candidates).toEqual([
            expect.objectContaining({
                recordingMbid: "deadbeef-1234",
                title: "Fallback title",
                artist: { id: null, name: "Fallback artist" },
                album: expect.objectContaining({ title: "Fallback album" }),
            }),
            expect.objectContaining({
                recordingMbid: "direct-mbid",
                title: "Direct title",
                artist: { id: null, name: "Direct artist" },
                album: expect.objectContaining({ title: "Single" }),
            }),
        ]);
    });

    it.each([null, "invalid", { playlist: { track: "invalid" } }])(
        "treats malformed JSPF as an empty response",
        async (data) => {
            mockAxiosPost.mockResolvedValue({ data });

            await expect(
                listenBrainzRecommendationAdapter.getCandidateBatch(
                    `malformed-jspf-${JSON.stringify(data)}`,
                    4,
                    0,
                ),
            ).resolves.toEqual({ candidates: [], degradedSources: [] });
        },
    );

    it("uses and bounds a valid last-good Redis cache after provider failure", async () => {
        mockAxiosGet.mockRejectedValue(new Error("provider down"));
        mockRedisGet.mockResolvedValue(
            JSON.stringify(
                Array.from({ length: 55 }, (_, index) => ({
                    id: `cached-${index}`,
                })),
            ),
        );

        const result =
            await listenBrainzRecommendationAdapter.getCandidateBatch(
                "redis-cache-user",
                4,
                0,
            );

        expect(result.candidates).toHaveLength(50);
        expect(result.degradedSources).toEqual(["listenbrainz"]);
        expect(mockRedisWithAbortSignal).toHaveBeenCalled();
    });

    it.each([null, "{}", "invalid-json"])(
        "ignores an unusable last-good cache",
        async (cached) => {
            mockAxiosGet.mockRejectedValue(new Error("provider down"));
            mockRedisGet.mockResolvedValue(cached);

            await expect(
                listenBrainzRecommendationAdapter.getCandidateBatch(
                    `invalid-cache-${String(cached)}`,
                    4,
                    0,
                ),
            ).resolves.toEqual({
                candidates: [],
                degradedSources: ["listenbrainz"],
            });
        },
    );

    it("keeps successful recommendations when cache persistence fails", async () => {
        mockRedisSet.mockRejectedValue(new Error("redis down"));

        const result =
            await listenBrainzRecommendationAdapter.getCandidateBatch(
                "redis-write-failure-user",
                4,
                0,
            );

        expect(result.candidates).toHaveLength(1);
        expect(result.degradedSources).toEqual([]);
    });
});
