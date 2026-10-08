const mockSelectSeed = jest.fn();
const mockLibraryRows = jest.fn();
const mockArtistLookup = jest.fn();
const mockLocalDislikes = jest.fn();
const mockLocalRepeat = jest.fn();
const mockYouTubeRepeat = jest.fn();
const mockSuppressed = jest.fn();
const mockExactDislikes = jest.fn();
const mockViewed = jest.fn();
const mockCanonicalDislikes = jest.fn();
const mockMappings = jest.fn();
const mockTrackRadio = jest.fn();
const mockArtistRadio = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        track: { findMany: mockLibraryRows },
        artist: { findFirst: mockArtistLookup, findUnique: mockArtistLookup },
        dislikedEntity: { findMany: mockLocalDislikes },
    },
}));
jest.mock(
    "../../librarySeedRadio",
    () => ({
        selectLibrarySeedRadio: (...args: unknown[]) => mockSelectSeed(...args),
        LibrarySeedRadioError: class extends Error {
            constructor(
                public status: number,
                message: string,
            ) {
                super(message);
            }
        },
    }),
    { virtual: true },
);
jest.mock("../../playlistRemoteRadio", () => ({
    buildRemoteTrackRadio: (...args: unknown[]) => mockTrackRadio(...args),
    buildRemoteArtistRadio: (...args: unknown[]) => mockArtistRadio(...args),
}));
jest.mock("../../personalizedTrackPreferences", () => ({
    loadLibraryRepeatExclusions: (...args: unknown[]) =>
        mockLocalRepeat(...args),
    loadYouTubeRepeatExclusions: (...args: unknown[]) =>
        mockYouTubeRepeat(...args),
    loadSuppressedYouTubeArtists: (...args: unknown[]) =>
        mockSuppressed(...args),
    loadDislikedYouTubeIds: (...args: unknown[]) => mockExactDislikes(...args),
    loadRecentlyViewedCanonicalKeys: (...args: unknown[]) =>
        mockViewed(...args),
}));
jest.mock("../featureStore", () => ({
    recommendationFeatureStore: {
        loadDislikedCanonicalKeys: (...args: unknown[]) =>
            mockCanonicalDislikes(...args),
    },
}));
jest.mock("../canonicalIdentity", () => {
    const actual = jest.requireActual("../canonicalIdentity");
    return {
        ...actual,
        findMappedCanonicalCandidates: (...args: unknown[]) =>
            mockMappings(...args),
    };
});

import { loadRadioContinuationCandidates } from "../radioContinuationRuntime";
import type { RadioContinuationInput } from "../radioContinuation";
import { createRadioRequestExecution } from "../radioRequestExecution";

const now = new Date("2026-10-08T00:20:00Z");
const track = (id: string) => ({
    id,
    title: id,
    duration: 180,
    artist: { id: "artist", name: id },
    album: { id: "album", title: "Album", coverArt: null },
});
const input: RadioContinuationInput = {
    userId: "alice",
    sessionId: "tab",
    cursor: 2,
    limit: 25,
    exclude: [],
    radioOrigin: { kind: "track", source: "youtube", id: "seedVideo01" },
};
const repeats = () => ({
    videoIds: new Set<string>(),
    songKeys: new Set<string>(),
    hardVideoIds: new Set<string>(),
    hardSongKeys: new Set<string>(),
});

beforeEach(() => {
    jest.resetAllMocks();
    mockSelectSeed.mockResolvedValue({ trackIds: ["fresh"] });
    mockLibraryRows.mockImplementation(async ({ where }) =>
        where.id.in.map((id: string) => ({
            id,
            title: id,
            duration: 180,
            trackNo: null,
            origin: "LOCAL",
            filePath: `/music/${id}.flac`,
            album: {
                id: "album",
                title: "Album",
                coverUrl: null,
                artist: { id: "artist", name: id },
            },
        })),
    );
    mockArtistLookup.mockResolvedValue({
        id: "original-artist",
        name: "Original",
    });
    mockLocalDislikes.mockResolvedValue([]);
    mockLocalRepeat.mockResolvedValue(repeats());
    mockYouTubeRepeat.mockResolvedValue(repeats());
    mockSuppressed.mockResolvedValue(new Set());
    mockExactDislikes.mockResolvedValue(new Set());
    mockViewed.mockResolvedValue(new Set());
    mockCanonicalDislikes.mockResolvedValue(new Set());
    mockMappings.mockImplementation(async (rows: unknown[]) =>
        rows.map(() => null),
    );
    mockTrackRadio.mockResolvedValue([
        { ...track("yt:freshVid001"), youtubeVideoId: "freshVid001" },
    ]);
    mockArtistRadio.mockResolvedValue([
        { ...track("yt:freshVid002"), youtubeVideoId: "freshVid002" },
    ]);
});

describe("actual original-radio runtime adapters", () => {
    it.each([null, { id: "matched-artist" }])(
        "does not start the next artist source after lookup cancellation: %j",
        async (matched) => {
            const controller = new AbortController();
            const execution = createRadioRequestExecution(controller.signal);
            let release!: (value: typeof matched) => void;
            mockArtistLookup.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            );
            const work = loadRadioContinuationCandidates(
                {
                    ...input,
                    execution,
                    radioOrigin: {
                        kind: "artist",
                        source: "discovery",
                        name: "Original",
                    },
                },
                now,
            ).catch((error: unknown) => error);
            for (let i = 0; i < 20; i++) await Promise.resolve();
            controller.abort();
            release(matched);
            expect(await work).toMatchObject({
                code: "RADIO_REQUEST_CANCELLED",
            });
            expect(mockArtistRadio).not.toHaveBeenCalled();
            expect(mockSelectSeed).not.toHaveBeenCalled();
            execution.dispose();
        },
    );
    it("does not hydrate library rows after a cancelled selector completes", async () => {
        const controller = new AbortController();
        const execution = createRadioRequestExecution(controller.signal);
        let release!: (value: { trackIds: string[] }) => void;
        mockSelectSeed.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const work = loadRadioContinuationCandidates(
            {
                ...input,
                execution,
                radioOrigin: { kind: "track", source: "library", id: "seed" },
            },
            now,
        ).catch((error: unknown) => error);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        controller.abort();
        release({ trackIds: ["fresh"] });
        expect(await work).toMatchObject({ code: "RADIO_REQUEST_CANCELLED" });
        expect(mockLibraryRows).not.toHaveBeenCalled();
        execution.dispose();
    });
    it.each([0, 1, 1_000_000])(
        "refreshes YouTube pools only for a positive continuation cursor %s",
        async (cursor) => {
            await loadRadioContinuationCandidates({ ...input, cursor }, now);
            expect(mockTrackRadio.mock.calls).toEqual([
                cursor > 0
                    ? ["seedVideo01", 100, { refresh: true }]
                    : ["seedVideo01", 100],
            ]);
        },
    );
    it.each([0, 1])(
        "forwards cursor %s to unmatched discovery artist radio",
        async (cursor) => {
            mockArtistLookup.mockResolvedValue(null);
            await loadRadioContinuationCandidates(
                {
                    ...input,
                    cursor,
                    radioOrigin: {
                        kind: "artist",
                        source: "discovery",
                        name: "Original",
                    },
                },
                now,
            );
            expect(mockArtistRadio).toHaveBeenCalledTimes(1);
            const args: unknown[] = ["Original", 100, expect.any(Function)];
            if (cursor > 0) args.push({ refresh: true });
            expect(mockArtistRadio).toHaveBeenCalledWith(...args);
            expect(mockSelectSeed).not.toHaveBeenCalled();
        },
    );
    it.each(["library", "discovery"] as const)(
        "delivers pool refresh to catalog-only %s artists through the local selector",
        async (source) => {
            const radioOrigin =
                source === "library"
                    ? { kind: "artist" as const, source, id: "catalog-artist" }
                    : { kind: "artist" as const, source, name: "Original" };
            for (const cursor of [0, 1]) {
                mockSelectSeed.mockClear();
                await loadRadioContinuationCandidates(
                    { ...input, cursor, radioOrigin },
                    now,
                );
                const request = mockSelectSeed.mock.calls[0][0];
                expect(request.type).toBe("artist");
                expect(request.value).toBe(
                    source === "library" ? "catalog-artist" : "original-artist",
                );
                if (cursor > 0) expect(request.refreshRemotePool).toBe(true);
                else expect(request).not.toHaveProperty("refreshRemotePool");
                expect(mockArtistRadio).not.toHaveBeenCalled();
            }
        },
    );
    it("uses the original YouTube seed, bounded reserve and one captured preference time", async () => {
        const batch = await loadRadioContinuationCandidates(input, now);
        expect(mockTrackRadio).toHaveBeenCalledWith("seedVideo01", 100, {
            refresh: true,
        });
        expect(batch.candidates.map((c) => c.id)).toEqual(["yt:freshVid001"]);
        expect(mockLocalRepeat).toHaveBeenCalledWith("alice", now);
        expect(mockYouTubeRepeat).toHaveBeenCalledWith("alice", now);
        expect(mockSuppressed).toHaveBeenCalledWith("alice", now);
        expect(mockArtistRadio).not.toHaveBeenCalled();
    });
    it.each(["track", "artist"] as const)(
        "preserves library %s intent and applies exclusions before selector quotas",
        async (kind) => {
            mockSelectSeed.mockImplementation(async (request) => {
                expect(request).toEqual(
                    expect.objectContaining({
                        type: kind === "track" ? "vibe" : "artist",
                        value: "original",
                        userId: "alice",
                        limit: 100,
                        allowRandomFallback: false,
                    }),
                );
                const admitted = await request.admitTrackIds([
                    "queued",
                    "disliked",
                    "viewed",
                    "fresh",
                ]);
                expect([...admitted]).toEqual(["fresh"]);
                return { trackIds: ["fresh"] };
            });
            mockLocalDislikes.mockResolvedValue([{ entityId: "disliked" }]);
            mockViewed.mockResolvedValue(new Set(["meta:viewed:viewed:180"]));
            const batch = await loadRadioContinuationCandidates(
                {
                    ...input,
                    radioOrigin: { kind, source: "library", id: "original" },
                    exclude: ["queued"],
                },
                now,
            );
            expect(batch.candidates.map((c) => c.id)).toEqual(["fresh"]);
            expect(mockTrackRadio).not.toHaveBeenCalled();
            expect(mockLocalDislikes).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        userId: "alice",
                        entityType: "track",
                        entityId: { in: ["disliked", "viewed", "fresh"] },
                    },
                }),
            );
        },
    );
    it("keeps discovery artist identity when it resolves to an existing library artist", async () => {
        const batch = await loadRadioContinuationCandidates(
            {
                ...input,
                radioOrigin: {
                    kind: "artist",
                    source: "discovery",
                    name: "Original",
                },
            },
            now,
        );
        expect(batch.candidates.map((c) => c.id)).toEqual(["fresh"]);
        expect(mockSelectSeed).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "artist",
                value: "original-artist",
            }),
        );
        expect(mockArtistRadio).not.toHaveBeenCalled();
    });
    it("excludes canonical aliases of the queue before local artist quotas", async () => {
        mockTrackRadio.mockResolvedValue([
            { ...track("yt:aliasVideo1"), youtubeVideoId: "aliasVideo1" },
            { ...track("yt:freshVid001"), youtubeVideoId: "freshVid001" },
        ]);
        mockMappings.mockImplementation(async (rows) =>
            rows.map((c: any) =>
                c.provider.youtubeVideoId === "aliasVideo1" ||
                c.provider.youtubeVideoId === "queuedVid01"
                    ? {
                          id: "shared-recording",
                          canonicalKey: "shared-recording-key",
                      }
                    : null,
            ),
        );
        const batch = await loadRadioContinuationCandidates(
            { ...input, exclude: ["yt:queuedVid01"] },
            now,
        );
        expect(batch.candidates.map((c) => c.id)).toEqual(["yt:freshVid001"]);
    });
    it("marks an unavailable required history reader as degraded without raw provider errors", async () => {
        mockYouTubeRepeat.mockRejectedValue(new Error("secret-url/token"));
        const batch = await loadRadioContinuationCandidates(input, now);
        expect(batch.degradedSources).toContain("radio-youtube-history");
        expect(JSON.stringify(batch)).not.toContain("secret-url");
    });
    it("returns exhausted provider radio without switching to an unrelated library pool", async () => {
        mockTrackRadio.mockRejectedValue(new Error("secret-provider-error"));
        const batch = await loadRadioContinuationCandidates(input, now);
        expect(batch.candidates).toEqual([]);
        expect(batch.degradedSources).toContain("youtube-radio");
        expect(mockSelectSeed).not.toHaveBeenCalled();
    });
    it("reports partial discovery-artist failure while retaining successful tracks", async () => {
        mockArtistLookup.mockResolvedValue(null);
        mockArtistRadio.mockImplementation(
            async (_name, _limit, onPartialFailure) => {
                onPartialFailure();
                return [
                    {
                        ...track("yt:freshVid002"),
                        youtubeVideoId: "freshVid002",
                    },
                ];
            },
        );
        const batch = await loadRadioContinuationCandidates(
            {
                ...input,
                radioOrigin: {
                    kind: "artist",
                    source: "discovery",
                    name: "Original",
                },
            },
            now,
        );
        expect(batch.candidates.map((c) => c.id)).toEqual(["yt:freshVid002"]);
        expect(batch.degradedSources).toContain("artist-radio");
    });
    it("reports partial remote-only library artist failure without replacing artist identity", async () => {
        mockSelectSeed.mockImplementation(async (request) => {
            request.onRemotePartialFailure();
            return {
                tracks: [
                    {
                        ...track("yt:freshVid002"),
                        youtubeVideoId: "freshVid002",
                    },
                ],
            };
        });
        const batch = await loadRadioContinuationCandidates(
            {
                ...input,
                radioOrigin: {
                    kind: "artist",
                    source: "library",
                    id: "catalog-artist",
                },
            },
            now,
        );
        expect(batch.candidates.map((c) => c.id)).toEqual(["yt:freshVid002"]);
        expect(batch.degradedSources).toContain("artist-radio");
    });
    it("rejects missing local paths before seed quotas while retaining federated playback rows", async () => {
        mockLibraryRows.mockImplementation(async ({ where }) =>
            where.id.in.map((id: string) => ({
                id,
                title: id,
                duration: 180,
                origin: id === "peer-song" ? "FEDERATED" : "LOCAL",
                filePath:
                    id === "missing-file" || id === "peer-song"
                        ? null
                        : id === "empty-file"
                          ? ""
                          : "/music/fresh.flac",
                album: {
                    id: "album",
                    title: "Album",
                    coverUrl: null,
                    artist: { id: "artist", name: id },
                },
            })),
        );
        mockSelectSeed.mockImplementation(async (request) => {
            const allowed = await request.admitTrackIds([
                "missing-file",
                "empty-file",
                "fresh",
                "peer-song",
            ]);
            expect([...allowed]).toEqual(["fresh", "peer-song"]);
            return { trackIds: [...allowed] };
        });
        const batch = await loadRadioContinuationCandidates(
            {
                ...input,
                radioOrigin: {
                    kind: "track",
                    source: "library",
                    id: "original",
                },
            },
            now,
        );
        expect(batch.candidates.map((c) => c.id)).toEqual([
            "fresh",
            "peer-song",
        ]);
        expect(JSON.stringify(batch)).not.toContain("/music/");
    });
});
