import { logger } from "../../utils/logger";
import type {
    RemoteTrackLookup,
    RemoteTrackMetadataInput,
} from "../remoteTrackMetadataResolver";
import {
    hasPlaceholderRemoteTrackMetadata,
    resolveRemoteTrackMetadataForRequest,
} from "../remoteTrackMetadataResolver";

jest.mock("../../utils/logger", () => ({
    logger: (() => {
        const child = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        return {
            child: jest.fn(() => child),
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            __childLogger: child,
        };
    })(),
}));

const mockedLogger = logger as unknown as {
    __childLogger: { debug: jest.Mock; warn: jest.Mock };
};

const mockYtGetSong = jest.fn();
jest.mock("../youtubeMusic", () => ({
    ytMusicService: { getSong: mockYtGetSong },
}));

describe("remoteTrackMetadataResolver", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockYtGetSong.mockReset();
    });

    describe("hasPlaceholderRemoteTrackMetadata", () => {
        it.each([
            [{ title: "", artist: "Artist", album: "Album" }],
            [{ title: "Unknown Track", artist: "Artist", album: "Album" }],
            [{ title: "Title", artist: "Unknown Artist", album: "Album" }],
            [{ title: "Title", artist: "Artist", album: "Single" }],
            [{ title: "Title", artist: "Artist", album: "Unknown Album" }],
        ])("recognizes placeholder metadata", (metadata) => {
            expect(hasPlaceholderRemoteTrackMetadata(metadata)).toBe(true);
        });

        it("recognizes missing or non-string fields", () => {
            const metadata = {
                title: "Real Title",
                artist: "Real Artist",
                album: 123,
            } as unknown as RemoteTrackMetadataInput;

            expect(hasPlaceholderRemoteTrackMetadata(metadata)).toBe(true);
        });

        it("accepts complete real metadata", () => {
            expect(
                hasPlaceholderRemoteTrackMetadata({
                    title: "Track Name",
                    artist: "Artist Name",
                    album: "Album Name",
                }),
            ).toBe(false);
        });
    });

    describe("resolveRemoteTrackMetadataForRequest", () => {
        it("normalizes complete request metadata without provider I/O", async () => {
            const lookup: RemoteTrackLookup = {
                provider: "youtube",
                userId: "user-1",
                videoId: "video-1",
                metadata: {
                    title: "  Title  ",
                    artist: "  Artist  ",
                    album: "  Album  ",
                    duration: 215.8,
                    thumbnailUrl: "  https://img.local/thumb.jpg  ",
                    isrc: "  US-S1Z-99-00001  ",
                    quality: "  HIGH  ",
                    explicit: false,
                },
            };

            await expect(
                resolveRemoteTrackMetadataForRequest(lookup),
            ).resolves.toEqual({
                title: "Title",
                artist: "Artist",
                album: "Album",
                duration: 215,
                thumbnailUrl: "https://img.local/thumb.jpg",
                isrc: "US-S1Z-99-00001",
                quality: "HIGH",
                explicit: false,
            });
            expect(mockYtGetSong).not.toHaveBeenCalled();
        });

        it("does not fetch missing artwork unless persisted enrichment opts in", async () => {
            const resolved = await resolveRemoteTrackMetadataForRequest({
                provider: "youtube",
                userId: "user-fast-path",
                videoId: "complete-video",
                metadata: {
                    title: "Complete Title",
                    artist: "Complete Artist",
                    album: "Complete Album",
                    duration: 205,
                },
            });

            expect(resolved.thumbnailUrl).toBeUndefined();
            expect(mockYtGetSong).not.toHaveBeenCalled();
        });

        it("repairs placeholders and artwork from YouTube Music metadata", async () => {
            mockYtGetSong.mockResolvedValueOnce({
                title: "Resolved title",
                artist: "Resolved artist",
                album: "Resolved album",
                duration: 234.9,
                thumbnails: [
                    { url: "https://img.local/small.jpg" },
                    { url: "https://img.local/large.jpg" },
                ],
            });

            const resolved = await resolveRemoteTrackMetadataForRequest({
                provider: "youtube",
                userId: "user-enrichment",
                videoId: "video-enrichment",
                fetchArtworkIfMissing: true,
                metadata: {
                    title: "Unknown",
                    artist: "Unknown Artist",
                    album: "Single",
                },
            });

            expect(mockYtGetSong).toHaveBeenCalledWith(
                "user-enrichment",
                "video-enrichment",
            );
            expect(resolved).toEqual({
                title: "Resolved title",
                artist: "Resolved artist",
                album: "Resolved album",
                duration: 234,
                thumbnailUrl: "https://img.local/large.jpg",
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
        });

        it("falls back to public YouTube Music metadata lookup", async () => {
            mockYtGetSong
                .mockRejectedValueOnce(new Error("private lookup failed"))
                .mockResolvedValueOnce({
                    title: "Public title",
                    artist: "Public artist",
                    album: "Public album",
                    duration: 198,
                });

            const resolved = await resolveRemoteTrackMetadataForRequest({
                provider: "youtube",
                userId: "user-1",
                videoId: "public-video",
                metadata: {
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Unknown",
                },
            });

            expect(mockYtGetSong).toHaveBeenNthCalledWith(
                1,
                "user-1",
                "public-video",
            );
            expect(mockYtGetSong).toHaveBeenNthCalledWith(
                2,
                "__public__",
                "public-video",
            );
            expect(mockedLogger.__childLogger.debug).toHaveBeenCalled();
            expect(resolved.title).toBe("Public title");
        });

        it("returns normalized defaults when the video id is missing", async () => {
            const metadata = {
                title: "   ",
                artist: "",
                album: "unknown",
                duration: Number.NaN,
                thumbnailUrl: "   ",
                isrc: 777,
                quality: null,
                explicit: "yes",
            } as unknown as RemoteTrackMetadataInput;

            const resolved = await resolveRemoteTrackMetadataForRequest({
                provider: "youtube",
                userId: "user-1",
                metadata,
            });

            expect(resolved).toEqual({
                title: "Unknown",
                artist: "Unknown",
                album: "unknown",
                duration: 180,
                thumbnailUrl: undefined,
                isrc: undefined,
                quality: undefined,
                explicit: undefined,
            });
            expect(mockYtGetSong).not.toHaveBeenCalled();
        });

        it("keeps normalized metadata when both YouTube lookups fail", async () => {
            mockYtGetSong
                .mockRejectedValueOnce(new Error("private failed"))
                .mockRejectedValueOnce(new Error("public failed"));

            const resolved = await resolveRemoteTrackMetadataForRequest({
                provider: "youtube",
                userId: "user-1",
                videoId: "failed-video",
                metadata: {
                    title: "Unknown",
                    artist: "Unknown",
                    album: "Unknown",
                },
            });

            expect(resolved.title).toBe("Unknown");
            expect(mockedLogger.__childLogger.warn).toHaveBeenCalledWith(
                "Failed to resolve inline metadata for youtube track",
                expect.any(Error),
            );
        });
    });

    describe("logger child fallback initialization", () => {
        it("uses the base logger when child is not a function", async () => {
            jest.resetModules();
            const fallbackWarn = jest.fn();

            jest.doMock("../../utils/logger", () => ({
                logger: {
                    child: "not-a-function",
                    debug: jest.fn(),
                    info: jest.fn(),
                    warn: fallbackWarn,
                    error: jest.fn(),
                },
            }));
            jest.doMock("../youtubeMusic", () => ({
                ytMusicService: {
                    getSong: jest.fn().mockRejectedValue(new Error("explode")),
                },
            }));

            const isolatedModule =
                await import("../remoteTrackMetadataResolver");
            const resolved =
                await isolatedModule.resolveRemoteTrackMetadataForRequest({
                    provider: "youtube",
                    userId: "user-no-child",
                    videoId: "video-no-child",
                    metadata: {
                        title: "Unknown",
                        artist: "Unknown",
                        album: "Unknown",
                    },
                });

            expect(resolved.title).toBe("Unknown");
            expect(fallbackWarn).toHaveBeenCalledWith(
                "Failed to resolve inline metadata for youtube track",
                expect.any(Error),
            );
        });
    });
});
