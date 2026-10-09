const mockNativeHistory = jest.fn();
const mockRadioPool = jest.fn();
const mockLibraryPool = jest.fn();
const mockLibraryRows = jest.fn();
const mockRadioMappings = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: {
        track: { findMany: mockLibraryRows },
        dislikedEntity: { findMany: jest.fn().mockResolvedValue([]) },
    },
}));
jest.mock("../verifiedSourceRepeats", () => ({
    loadVerifiedSourceRepeatExclusions: (...args: unknown[]) =>
        mockNativeHistory(...args),
}));
jest.mock("../../librarySeedRadio", () => ({
    selectLibrarySeedRadio: (...args: unknown[]) => mockLibraryPool(...args),
    LibrarySeedRadioError: class extends Error {},
}));
jest.mock("../../playlistRemoteRadio", () => ({
    buildRemoteTrackRadio: (...args: unknown[]) => mockRadioPool(...args),
    buildRemoteArtistRadio: jest.fn(),
}));
jest.mock("../../personalizedTrackPreferences", () => ({
    loadLibraryRepeatExclusions: async () => ({
        videoIds: new Set(),
        songKeys: new Set(),
    }),
    loadYouTubeRepeatExclusions: async () => ({
        videoIds: new Set(),
        songKeys: new Set(),
    }),
    loadSuppressedYouTubeArtists: async () => new Set(),
    loadDislikedYouTubeIds: async () => new Set(),
    loadRecentlyViewedCanonicalKeys: async () => new Set(),
}));
jest.mock("../featureStore", () => ({
    recommendationFeatureStore: {
        loadDislikedCanonicalKeys: async () => new Set(),
    },
}));
jest.mock("../canonicalIdentity", () => ({
    ...jest.requireActual("../canonicalIdentity"),
    findMappedCanonicalCandidates: (...args: unknown[]) =>
        mockRadioMappings(...args),
}));

import { loadRadioContinuationCandidates } from "../radioContinuationRuntime";
import { createRadioRequestExecution } from "../radioRequestExecution";
import type { RadioContinuationInput } from "../radioContinuation";

const NOW = new Date("2026-10-08T12:00:00Z");
const input: RadioContinuationInput = {
    userId: "alice",
    sessionId: "new-tab",
    cursor: 0,
    limit: 25,
    exclude: [],
    radioOrigin: { kind: "track", source: "youtube", id: "seedVideo01" },
};
const track = (id: string) => ({
    id,
    title: id,
    duration: 180,
    artist: { id: null, name: id },
    album: { id: null, title: "Album", coverArt: null },
});
beforeEach(() => {
    jest.clearAllMocks();
    mockNativeHistory.mockResolvedValue({
        ids: new Set(["vk:-001_002", "known-native-key"]),
        hardIds: new Set(["known-native-key"]),
    });
    mockRadioPool.mockResolvedValue([
        { ...track("yt:repeatVid01"), youtubeVideoId: "repeatVid01" },
        { ...track("yt:freshVid001"), youtubeVideoId: "freshVid001" },
    ]);
    mockRadioMappings.mockImplementation(async (rows) =>
        rows.map((row: any) =>
            row.id === "yt:repeatVid01" || row.id === "repeat"
                ? { id: "native-canonical", canonicalKey: "known-native-key" }
                : null,
        ),
    );
    mockLibraryRows.mockImplementation(async ({ where }) =>
        where.id.in.map((id: string) => ({
            ...track(id),
            origin: "LOCAL",
            filePath: "/music/song.flac",
            trackNo: null,
            album: {
                id: "album",
                title: "Album",
                coverUrl: null,
                artist: { id: "artist", name: id },
            },
        })),
    );
});

describe("verified native listening at the actual radio pre-quota boundary", () => {
    it("filters a known canonical repeat from the original YouTube pool without title matching", async () => {
        const result = await loadRadioContinuationCandidates(input, NOW);
        expect(result.candidates.map((candidate) => candidate.id)).toEqual([
            "yt:freshVid001",
        ]);
        expect(mockNativeHistory).toHaveBeenCalledTimes(1);
        expect(mockNativeHistory).toHaveBeenCalledWith("alice", NOW);
    });

    it("filters a known canonical repeat before the local selector consumes its quota", async () => {
        mockLibraryPool.mockImplementation(async (request) => {
            const admitted = await request.admitTrackIds(["repeat", "fresh"]);
            expect([...admitted]).toEqual(["fresh"]);
            return { trackIds: [...admitted] };
        });
        const result = await loadRadioContinuationCandidates(
            {
                ...input,
                radioOrigin: { kind: "track", source: "library", id: "seed" },
            },
            NOW,
        );
        expect(result.candidates.map((candidate) => candidate.id)).toEqual([
            "fresh",
        ]);
        expect(mockNativeHistory).toHaveBeenCalledTimes(1);
    });

    it("reports native history failure without exposing raw details or hiding the independent old pool", async () => {
        mockNativeHistory.mockRejectedValue(
            new Error("secret-cookie/upstream-url"),
        );
        const result = await loadRadioContinuationCandidates(input, NOW);
        expect(result.candidates).toHaveLength(2);
        expect(result.degradedSources).toContain("radio-source-history");
        expect(JSON.stringify(result)).not.toContain("secret-cookie");
    });

    it("does not start the provider after owner cancellation during native history", async () => {
        const controller = new AbortController();
        const execution = createRadioRequestExecution(controller.signal);
        let release!: (value: {
            ids: Set<string>;
            hardIds: Set<string>;
        }) => void;
        mockNativeHistory.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const work = loadRadioContinuationCandidates(
            { ...input, execution },
            NOW,
        ).catch((error: unknown) => error);
        for (let i = 0; i < 30; i++) await Promise.resolve();
        controller.abort();
        if (release) release({ ids: new Set(), hardIds: new Set() });
        const result = await work;
        expect(result).toMatchObject({ code: "RADIO_REQUEST_CANCELLED" });
        expect(mockRadioPool).not.toHaveBeenCalled();
        execution.dispose();
    });
});
