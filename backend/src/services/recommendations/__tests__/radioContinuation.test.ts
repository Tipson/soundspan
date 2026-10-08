import { UnifiedRecommendationService } from "../recommendationService";
import { createRadioContinuationLoader } from "../radioContinuation";
import type { PlaybackRadioOrigin } from "@soundspan/media-metadata-contract";

const now = new Date("2026-10-08T00:20:00Z");
const origin: PlaybackRadioOrigin = {
    kind: "track",
    source: "youtube",
    id: "seedVideo01",
};
const yt = (id: string, artist = id, title = id) => ({
    id: `yt:${id}`,
    youtubeVideoId: id,
    title,
    duration: 180,
    artist: { id: null, name: artist },
    album: { id: null, title: "Album", coverArt: null },
});
const local = (id: string) => ({
    id,
    title: id,
    duration: 180,
    artist: { id: "local-artist", name: id },
    album: { id: "album", title: "Local album", coverArt: null },
    filePath: "/private/audio.flac",
    token: "private",
});
const preferences = () => ({
    ids: new Set<string>(),
    songKeys: new Set<string>(),
    suppressedArtists: new Set<string>(),
    degradedSources: [] as string[],
});
function setup(tracks: unknown[]) {
    const loadSeedTracks = jest
        .fn()
        .mockResolvedValue({ tracks, degradedSources: [] });
    const loadPreferences = jest.fn().mockResolvedValue(preferences());
    const admitCandidates = jest
        .fn()
        .mockImplementation(async (_user, candidates) => ({
            candidates,
            degradedSources: [],
        }));
    const loadLibraryTracks = jest
        .fn()
        .mockImplementation(async (ids: readonly string[]) => ids.map(local));
    const loader = createRadioContinuationLoader({
        loadSeedTracks,
        loadPreferences,
        admitCandidates,
        loadLibraryTracks,
    });
    return {
        loader,
        loadSeedTracks,
        loadPreferences,
        admitCandidates,
        loadLibraryTracks,
    };
}
const input = {
    userId: "alice",
    sessionId: "tab",
    radioOrigin: origin,
    cursor: 0,
    limit: 25,
    exclude: [] as string[],
};

describe("original-station radio continuation candidates", () => {
    it("keeps the original seed across pages and filters queue aliases before the final engine quota", async () => {
        const fixture = setup([
            yt("seedVideo01"),
            yt("queuedVid01"),
            yt("freshVid001"),
            local("local-one"),
        ]);
        const batch = await fixture.loader(
            { ...input, cursor: 4, exclude: ["queuedVid01"] },
            now,
        );
        expect(fixture.loadSeedTracks).toHaveBeenCalledWith(
            expect.objectContaining({
                radioOrigin: origin,
                cursor: 4,
                limit: 100,
            }),
            expect.any(Function),
        );
        expect(fixture.loadPreferences).toHaveBeenCalledWith("alice", now);
        expect(batch.candidates.map((c) => c.id)).toEqual([
            "yt:freshVid001",
            "local-one",
        ]);
        expect(batch.nextCursor).toBe(5);
        expect(batch.degradedSources).toEqual([]);
    });

    it("rejects malformed rows before exposures while preserving valid local and YouTube variants", async () => {
        const fixture = setup([
            yt("freshVid001"),
            local("local-one"),
            { ...yt("bad"), title: "Bad id" },
            { ...local("bad-time"), duration: NaN },
            { ...local("bad-title"), title: "" },
            null,
            {
                ...yt("freshVid002"),
                provider: { youtubeVideoId: "otherVid001" },
            },
            { ...local("retired"), source: "tidal", tidalTrackId: 1 },
        ]);
        const batch = await fixture.loader(input, now);
        expect(batch.candidates.map((c) => c.id)).toEqual([
            "yt:freshVid001",
            "local-one",
        ]);
        expect(
            batch.candidates.every(
                (c) => !("filePath" in c) && !("token" in c),
            ),
        ).toBe(true);
    });

    it("applies actual listening, alternate-upload keys and artist suppression before admission", async () => {
        const fixture = setup([
            yt("attemptVid1"),
            yt("aliasVideo1", "Artist", "The song"),
            yt("blockedVid1", "Blocked artist"),
            yt("freshVid001"),
        ]);
        fixture.loadPreferences.mockResolvedValue({
            ...preferences(),
            ids: new Set(["attemptVid1"]),
            songKeys: new Set([JSON.stringify(["artist", "the song"])]),
            suppressedArtists: new Set(["blocked artist"]),
        });
        const batch = await fixture.loader(input, now);
        expect(batch.candidates.map((c) => c.id)).toEqual(["yt:freshVid001"]);
        expect(
            fixture.admitCandidates.mock.calls[0][1].map(
                (c: { id: string }) => c.id,
            ),
        ).toEqual(["yt:freshVid001"]);
    });

    it("rejects conflicting source identities before ranking instead of creating phantom local songs", async () => {
        const fixture = setup([
            { ...local("unsupported"), source: "unknown-provider" },
            { ...local("bad-provider"), provider: { youtubeVideoId: 123 } },
            { ...yt("freshVid003"), id: "yt:otherVid001" },
            { ...yt("freshVid004"), source: "library" },
            {
                ...yt("freshVid005"),
                provider: { youtubeVideoId: "freshVid005", tidalTrackId: 99 },
            },
            { ...yt("freshVid001"), id: "radio:freshVid001" },
            local("local-good"),
        ]);
        const batch = await fixture.loader(input, now);
        expect(batch.candidates.map((c) => c.id)).toEqual([
            "yt:freshVid001",
            "local-good",
        ]);
    });

    it("does not bypass an existing suppressed artist through a local copy in mixed continuation", async () => {
        const fixture = setup([
            { ...local("local-blocked"), artist: { name: "Blocked Artist" } },
            yt("blockedVid1", "Blocked Artist"),
            local("local-good"),
        ]);
        fixture.loadPreferences.mockResolvedValue({
            ...preferences(),
            suppressedArtists: new Set(["blocked artist"]),
        });
        const batch = await fixture.loader(input, now);
        expect(batch.candidates.map((c) => c.id)).toEqual(["local-good"]);
        expect(
            fixture.admitCandidates.mock.calls[0][1].map(
                (c: { id: string }) => c.id,
            ),
        ).toEqual(["local-good"]);
    });

    it("passes the same owner/time exclusions to local selection before its counts and fallback", async () => {
        const fixture = setup([]);
        fixture.loadPreferences.mockResolvedValue({
            ...preferences(),
            ids: new Set(["library:blocked"]),
        });
        fixture.admitCandidates.mockImplementation(
            async (_user, candidates, time) => {
                expect(time).toBe(now);
                return {
                    candidates: candidates.filter(
                        (c: { id: string }) => c.id !== "disliked",
                    ),
                    degradedSources: [],
                };
            },
        );
        fixture.loadSeedTracks.mockImplementation(async (request, admitIds) => {
            expect(request.radioOrigin).toEqual({
                kind: "track",
                source: "library",
                id: "local-seed",
            });
            const allowed = await admitIds(["blocked", "disliked", "fresh"]);
            expect([...allowed]).toEqual(["fresh"]);
            return { tracks: [local("fresh")], degradedSources: [] };
        });
        const batch = await fixture.loader(
            {
                ...input,
                radioOrigin: {
                    kind: "track",
                    source: "library",
                    id: "local-seed",
                },
            },
            now,
        );
        expect(batch.candidates.map((c) => c.id)).toEqual(["fresh"]);
    });

    it("returns bounded empty exhaustion and sanitized degradation without changing the seed", async () => {
        const fixture = setup([]);
        fixture.loadSeedTracks.mockResolvedValue({
            tracks: [],
            degradedSources: ["youtube-radio"],
        });
        const batch = await fixture.loader(
            { ...input, cursor: 1_000_000 },
            now,
        );
        expect(batch).toEqual({
            candidates: [],
            nextCursor: 0,
            degradedSources: ["youtube-radio"],
        });
    });
});

describe("radio facade membership and existing engine policy", () => {
    it.each(["baseline", "shadow", "active"] as const)(
        "keeps ordered mixed-source served membership in %s",
        async (mode) => {
            const fixture = setup([
                local("local-one"),
                yt("freshVid001"),
                yt("viewedVid01"),
                yt("dislikeVid1"),
            ]);
            const recorded: unknown[] = [];
            const service = new UnifiedRecommendationService({
                mode,
                hybridRolloutPercent: 100,
                explorationRate: 0,
                loadRadioCandidates: fixture.loader,
                loadPersonalizedFeed: jest.fn(),
                loadSimilarCandidates: jest.fn(),
                resolveCanonical: async (c) => ({
                    id: c.id,
                    canonicalKey: c.canonicalKey,
                }),
                loadRecentExposures: async () => [
                    {
                        canonicalKey: "meta:viewedvid01:viewedvid01:180",
                        exposedAt: new Date(now.getTime() - 1_000),
                    },
                ],
                loadDislikedCanonicalKeys: async () =>
                    new Set(["meta:dislikevid1:dislikevid1:180"]),
                loadTasteContext: async () => ({
                    positiveCentroids: [],
                    negativeCentroids: [],
                }),
                recordGeneration: async (generation) => {
                    recorded.push(generation);
                    return "station-generation";
                },
                scheduleHotSet: async () => {},
                now: () => now,
            });
            const result = await service.recommendRadio({ ...input, limit: 2 });
            expect(result.radioOrigin).toEqual(origin);
            expect(result.tracks.map((c) => c.id).sort()).toEqual([
                "local-one",
                "yt:freshVid001",
            ]);
            const served = recorded.filter((g: any) => g.served) as any[];
            expect(served).toHaveLength(1);
            expect(
                served[0].recommendations.map((r: any) => r.track.id),
            ).toEqual(result.tracks.map((c) => c.id));
            expect(
                result.tracks.every(
                    (c) =>
                        !("embedding" in c) &&
                        !("canonicalKey" in c) &&
                        !("filePath" in c),
                ),
            ).toBe(true);
            expect(result.generationId).toBe("station-generation");
            expect(result.tracks).toHaveLength(2);
        },
    );
});
