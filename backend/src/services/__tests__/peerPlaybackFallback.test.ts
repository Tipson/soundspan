const mockTrackFindUnique = jest.fn();
const mockTrackMappingFindMany = jest.fn();
const mockSystemSettingsFindUnique = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        track: { findUnique: mockTrackFindUnique },
        trackMapping: { findMany: mockTrackMappingFindMany },
        systemSettings: { findUnique: mockSystemSettingsFindUnique },
    },
}));

import {
    choosePeerPlaybackFallback,
    loadPeerPlaybackFallback,
} from "../peerPlaybackFallback";

describe("peer playback fallback ladder", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTrackFindUnique.mockResolvedValue({
            dedupOfTrackId: null,
            duration: 180,
        });
        mockSystemSettingsFindUnique.mockResolvedValue({
            playbackSourceOrder: "library,peers,ytmusic",
        });
    });

    it("selects the local dedup twin before provider mappings", () => {
        expect(
            choosePeerPlaybackFallback({
                localTwinId: "local-1",
                youtubeVideoId: "video-1",
            }),
        ).toEqual([
            { source: "library", trackId: "local-1" },
            { source: "ytmusic", youtubeVideoId: "video-1" },
        ]);
    });

    it("selects a YouTube Music mapping without a local twin", () => {
        expect(
            choosePeerPlaybackFallback({
                localTwinId: null,
                youtubeVideoId: "video-1",
            }),
        ).toEqual([{ source: "ytmusic", youtubeVideoId: "video-1" }]);
    });

    it("returns an empty ladder when no fallback exists", () => {
        expect(
            choosePeerPlaybackFallback({
                localTwinId: null,
                youtubeVideoId: null,
            }),
        ).toEqual([]);
    });

    it.each([
        ["low-confidence", 0.69, 180],
        ["duration-mismatch", 0.9, 196],
    ])("skips a %s provider mapping", async (_name, confidence, duration) => {
        mockTrackMappingFindMany.mockResolvedValueOnce([
            {
                confidence,
                trackTidal: { tidalId: 42, duration },
                trackYtMusic: null,
            },
        ]);

        await expect(loadPeerPlaybackFallback("peer-track")).resolves.toEqual(
            [],
        );
    });

    it("ignores a historical TIDAL-only provider mapping", async () => {
        mockTrackMappingFindMany.mockResolvedValueOnce([
            {
                confidence: 0.7,
                trackTidal: { tidalId: 42, duration: 195 },
                trackYtMusic: null,
            },
        ]);

        await expect(loadPeerPlaybackFallback("peer-track")).resolves.toEqual(
            [],
        );
    });
});
