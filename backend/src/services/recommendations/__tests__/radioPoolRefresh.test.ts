const mockTransport = { get: jest.fn() };
jest.mock("axios", () => ({
    __esModule: true,
    default: { create: () => mockTransport },
}));
jest.mock("../../../config", () => ({
    config: { ytmusicStreamer: { url: "http://synthetic.invalid" } },
}));
jest.mock("../../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});
jest.mock("../../../utils/db", () => ({
    prisma: new Proxy(
        {},
        {
            get() {
                throw new Error(
                    "Unexpected database access in provider-pool test",
                );
            },
        },
    ),
}));
jest.mock("../../librarySeedRadio", () => ({
    selectLibrarySeedRadio: jest.fn(() => {
        throw new Error("Unexpected local fallback");
    }),
    LibrarySeedRadioError: class extends Error {},
}));
const mockRepeat = jest.fn();
const mockNativeRepeat = jest.fn();
const mockDisliked = jest.fn();
jest.mock("../../personalizedTrackPreferences", () => ({
    loadYouTubeRepeatExclusions: (...args: unknown[]) => mockRepeat(...args),
    loadLibraryRepeatExclusions: async () => ({
        videoIds: new Set(),
        songKeys: new Set(),
    }),
    loadSuppressedYouTubeArtists: async () => new Set(),
    loadDislikedYouTubeIds: (...args: unknown[]) => mockDisliked(...args),
    loadRecentlyViewedCanonicalKeys: async () => new Set(),
}));
jest.mock("../featureStore", () => ({
    recommendationFeatureStore: {
        loadDislikedCanonicalKeys: async () => new Set(),
    },
}));
jest.mock("../verifiedSourceRepeats", () => ({
    loadVerifiedSourceRepeatExclusions: (...args: unknown[]) =>
        mockNativeRepeat(...args),
}));
jest.mock("../canonicalIdentity", () => ({
    ...jest.requireActual("../canonicalIdentity"),
    findMappedCanonicalCandidates: async (rows: unknown[]) =>
        rows.map(() => null),
}));

import { ytMusicService } from "../../youtubeMusic";
import { loadRadioContinuationCandidates } from "../radioContinuationRuntime";
import type { RadioContinuationInput } from "../radioContinuation";

const seed = "Seed0000000";
const rows = (offset: number) =>
    Array.from({ length: 100 }, (_, index) => ({
        videoId: "v" + String(offset + index).padStart(10, "0"),
        title: "Synthetic song " + (offset + index),
        artist: "Synthetic artist",
        album: "Synthetic album",
        duration: 180,
    }));
const old = rows(1);
const fresh = rows(101);
const input: RadioContinuationInput = {
    userId: "alice",
    sessionId: "tab",
    cursor: 0,
    limit: 25,
    radioOrigin: { kind: "track", source: "youtube", id: seed },
    exclude: old.slice(0, 80).map((track) => "yt:" + track.videoId),
};
const policyTime = new Date("2026-10-08T00:00:00Z");

beforeEach(() => {
    jest.resetAllMocks();
    (
        ytMusicService as unknown as { radioLoaders: Map<string, unknown> }
    ).radioLoaders.clear();
    mockRepeat.mockResolvedValue({
        videoIds: new Set(old.slice(80).map((track) => "yt:" + track.videoId)),
        songKeys: new Set(),
    });
    mockDisliked.mockResolvedValue(new Set());
    mockNativeRepeat.mockResolvedValue({ ids: new Set(), hardIds: new Set() });
});

test("an exhausted cached pool refreshes before TTL through the actual runtime, provider cache, formatter and admission", async () => {
    mockTransport.get
        .mockResolvedValueOnce({ data: { tracks: old } })
        .mockResolvedValueOnce({ data: { tracks: fresh } });
    const initial = await loadRadioContinuationCandidates(input, policyTime);
    const cached = await loadRadioContinuationCandidates(input, policyTime);
    expect(initial.candidates).toEqual([]);
    expect(cached.candidates).toEqual([]);
    expect(mockTransport.get).toHaveBeenCalledTimes(1);
    const next = await loadRadioContinuationCandidates(
        { ...input, cursor: 1 },
        policyTime,
    );
    expect(
        next.candidates.map((track) => track.provider.youtubeVideoId),
    ).toEqual(fresh.map((track) => track.videoId));
    expect(next.degradedSources).toEqual([]);
    expect(next.nextCursor).toBe(2);
    expect(mockTransport.get.mock.calls).toEqual(
        Array.from({ length: 2 }, () => [
            "/radio",
            { params: { video_id: seed, limit: 100 }, timeout: 13_000 },
        ]),
    );
    expect(mockRepeat.mock.calls).toEqual(
        Array.from({ length: 3 }, () => ["alice", policyTime]),
    );
    expect(mockNativeRepeat.mock.calls).toEqual(
        Array.from({ length: 3 }, () => ["alice", policyTime, undefined]),
    );
});

test("owners share a fresh public fill but apply their own history, queue and dislikes separately", async () => {
    mockTransport.get.mockResolvedValueOnce({ data: { tracks: old } });
    await loadRadioContinuationCandidates(input, policyTime);
    let release!: (value: { data: { tracks: typeof fresh } }) => void;
    mockTransport.get.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    mockRepeat.mockImplementation(async (owner: string) => ({
        videoIds: new Set(["yt:" + fresh[owner === "alice" ? 0 : 1].videoId]),
        songKeys: new Set(),
    }));
    mockDisliked.mockImplementation(
        async (owner: string) =>
            new Set([fresh[owner === "alice" ? 2 : 3].videoId]),
    );
    const a = loadRadioContinuationCandidates(
        { ...input, cursor: 1, exclude: ["yt:" + fresh[4].videoId] },
        policyTime,
    );
    const b = loadRadioContinuationCandidates(
        {
            ...input,
            userId: "bob",
            cursor: 1,
            exclude: ["yt:" + fresh[5].videoId],
        },
        policyTime,
    );
    for (let iteration = 0; iteration < 20 && !release; iteration++)
        await Promise.resolve();
    try {
        expect(mockTransport.get).toHaveBeenCalledTimes(2);
    } finally {
        release?.({ data: { tracks: fresh } });
    }
    const [alice, bob] = await Promise.all([a, b]);
    expect(
        alice.candidates.map((track) => track.provider.youtubeVideoId),
    ).toEqual(
        fresh
            .filter((_, index) => ![0, 2, 4].includes(index))
            .map((track) => track.videoId),
    );
    expect(
        bob.candidates.map((track) => track.provider.youtubeVideoId),
    ).toEqual(
        fresh
            .filter((_, index) => ![1, 3, 5].includes(index))
            .map((track) => track.videoId),
    );
    expect(mockTransport.get).toHaveBeenCalledTimes(2);
    expect(alice.degradedSources).toEqual([]);
    expect(bob.degradedSources).toEqual([]);
});
