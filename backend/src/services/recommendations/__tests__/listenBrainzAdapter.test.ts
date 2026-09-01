jest.mock("../../../utils/db", () => ({ prisma: {} }));
jest.mock("../../../utils/encryption", () => ({ decrypt: jest.fn() }));
jest.mock("../../../utils/redis", () => ({ redisClient: {} }));
jest.mock("../../../utils/logger", () => ({
    logger: {
        child: () => ({ warn: jest.fn() }),
    },
}));
jest.mock("../../youtubeMusic", () => ({ ytMusicService: {} }));

import { ListenBrainzRecommendationAdapter } from "../listenBrainzAdapter";

describe("ListenBrainz recommendation adapter", () => {
    function dependencies() {
        return {
            loadConnection: jest.fn().mockResolvedValue({
                username: "alice",
                token: "secret",
            }),
            fetchCollaborativeMbids: jest
                .fn()
                .mockResolvedValue(["mbid-1", "mbid-2"]),
            fetchTagRadioMetadata: jest.fn().mockResolvedValue([]),
            fetchRecordingMetadata: jest.fn().mockResolvedValue([
                {
                    recordingMbid: "mbid-1",
                    title: "Song One",
                    artist: "Artist One",
                },
            ]),
            resolvePlayable: jest.fn().mockResolvedValue({
                videoId: "video-1",
                title: "Song One",
                duration: 180,
            }),
            readLastGood: jest.fn().mockResolvedValue(null),
            writeLastGood: jest.fn().mockResolvedValue(undefined),
            now: jest.fn(() => new Date("2026-09-01T12:00:00.000Z")),
        };
    }

    it("resolves account CF MBIDs into playable provider candidates", async () => {
        const deps = dependencies();
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        const tracks = await adapter.getCandidates("alice-id", 12, 0);

        expect(deps.fetchCollaborativeMbids).toHaveBeenCalledWith(
            { username: "alice", token: "secret" },
            24,
            0,
        );
        expect(tracks).toEqual([
            expect.objectContaining({
                id: "yt:video-1",
                canonicalKey: "mbid:mbid-1",
                recordingMbid: "mbid-1",
                candidateSources: ["listenbrainz-cf"],
            }),
        ]);
        expect(deps.writeLastGood).toHaveBeenCalledWith(
            "alice-id",
            tracks,
            expect.any(AbortSignal),
        );
    });

    it("uses last-good cache when the experimental API fails", async () => {
        const deps = dependencies();
        deps.fetchCollaborativeMbids.mockRejectedValue(new Error("down"));
        const cached = [
            {
                id: "yt:cached",
                canonicalKey: "mbid:cached",
                title: "Cached",
                duration: 180,
                artist: { id: null, name: "Artist" },
                album: { id: null, title: "Single", coverArt: null },
                source: "youtube" as const,
                provider: { tidalTrackId: null, youtubeVideoId: "cached" },
                streamSource: "youtube" as const,
                youtubeVideoId: "cached",
                candidateSources: ["listenbrainz-cache"],
                providerPrior: 0.8,
            },
        ];
        deps.readLastGood.mockResolvedValue(cached);
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        await expect(adapter.getCandidates("alice-id", 12, 0)).resolves.toEqual(
            cached,
        );
    });

    it("bounds connection loading inside the total provider deadline", async () => {
        jest.useFakeTimers();
        const deps = dependencies();
        deps.loadConnection.mockImplementation(
            () => new Promise(() => undefined),
        );
        const cached = [
            {
                id: "yt:cached",
                canonicalKey: "mbid:cached",
                title: "Cached",
                duration: 180,
                artist: { id: null, name: "Artist" },
                album: { id: null, title: "Single", coverArt: null },
                source: "youtube" as const,
                provider: { tidalTrackId: null, youtubeVideoId: "cached" },
                streamSource: "youtube" as const,
                youtubeVideoId: "cached",
                candidateSources: ["listenbrainz-cache"],
                providerPrior: 0.8,
            },
        ];
        deps.readLastGood.mockResolvedValue(cached);
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        const result = adapter.getCandidateBatch("alice-id", 12, 0);
        await jest.advanceTimersByTimeAsync(6_000);

        await expect(result).resolves.toEqual({
            candidates: cached,
            degradedSources: ["listenbrainz"],
        });
        jest.useRealTimers();
    });

    it("reports provider degradation while preserving the last-good fallback", async () => {
        const deps = dependencies();
        deps.fetchCollaborativeMbids.mockRejectedValue(new Error("down"));
        const cached = [
            {
                id: "yt:cached",
                canonicalKey: "mbid:cached",
                title: "Cached",
                duration: 180,
                artist: { id: null, name: "Artist" },
                album: { id: null, title: "Single", coverArt: null },
                source: "youtube" as const,
                provider: { tidalTrackId: null, youtubeVideoId: "cached" },
                streamSource: "youtube" as const,
                youtubeVideoId: "cached",
                candidateSources: ["listenbrainz-cache"],
                providerPrior: 0.8,
            },
        ];
        deps.readLastGood.mockResolvedValue(cached);
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        await expect(
            adapter.getCandidateBatch("alice-id", 12, 0),
        ).resolves.toEqual({
            candidates: cached,
            degradedSources: ["listenbrainz"],
        });
    });

    it("marks partial playable-resolution errors without dropping successful candidates", async () => {
        const deps = dependencies();
        deps.fetchRecordingMetadata.mockResolvedValue([
            { recordingMbid: "mbid-1", title: "One", artist: "Artist" },
            { recordingMbid: "mbid-2", title: "Two", artist: "Artist" },
        ]);
        deps.resolvePlayable
            .mockResolvedValueOnce({
                videoId: "video-1",
                title: "One",
                duration: 180,
            })
            .mockRejectedValueOnce(new Error("resolver down"));
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        const batch = await adapter.getCandidateBatch("alice-id", 12, 0);

        expect(batch.candidates.map((candidate) => candidate.id)).toEqual([
            "yt:video-1",
        ]);
        expect(batch.degradedSources).toEqual(["listenbrainz-resolve"]);
    });

    it("uses last-good and records degradation when every playable resolution rejects", async () => {
        const deps = dependencies();
        deps.fetchRecordingMetadata.mockResolvedValue([
            { recordingMbid: "mbid-1", title: "One", artist: "Artist" },
            { recordingMbid: "mbid-2", title: "Two", artist: "Artist" },
        ]);
        deps.resolvePlayable.mockRejectedValue(new Error("resolver down"));
        const cached = [
            {
                id: "yt:cached",
                canonicalKey: "mbid:cached",
                title: "Cached",
                duration: 180,
                artist: { id: null, name: "Artist" },
                album: { id: null, title: "Single", coverArt: null },
                source: "youtube" as const,
                provider: { tidalTrackId: null, youtubeVideoId: "cached" },
                streamSource: "youtube" as const,
                youtubeVideoId: "cached",
                candidateSources: ["listenbrainz-cache"],
                providerPrior: 0.8,
            },
        ];
        deps.readLastGood.mockResolvedValue(cached);
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        await expect(
            adapter.getCandidateBatch("alice-id", 12, 0),
        ).resolves.toEqual({
            candidates: cached,
            degradedSources: ["listenbrainz"],
        });
        expect(deps.writeLastGood).not.toHaveBeenCalled();
    });

    it("aborts in-flight playable resolution and falls back within one bounded deadline", async () => {
        jest.useFakeTimers();
        const deps = dependencies();
        const observedSignals: AbortSignal[] = [];
        deps.resolvePlayable.mockImplementation(
            (_userId, _recording, signal?: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    if (!signal) return;
                    observedSignals.push(signal);
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("aborted")),
                        { once: true },
                    );
                }),
        );
        const cached = [
            {
                id: "yt:cached",
                canonicalKey: "mbid:cached",
                title: "Cached",
                duration: 180,
                artist: { id: null, name: "Artist" },
                album: { id: null, title: "Single", coverArt: null },
                source: "youtube" as const,
                provider: { tidalTrackId: null, youtubeVideoId: "cached" },
                streamSource: "youtube" as const,
                youtubeVideoId: "cached",
                candidateSources: ["listenbrainz-cache"],
                providerPrior: 0.8,
            },
        ];
        deps.readLastGood.mockResolvedValue(cached);
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        const result = adapter.getCandidateBatch("alice-id", 12, 0);
        await jest.advanceTimersByTimeAsync(6_000);

        await expect(result).resolves.toEqual({
            candidates: cached,
            degradedSources: ["listenbrainz"],
        });
        expect(deps.resolvePlayable).toHaveBeenCalledTimes(1);
        expect(observedSignals).toHaveLength(1);
        expect(observedSignals[0]?.aborted).toBe(true);
        jest.useRealTimers();
    });

    it("bounds a hanging last-good read instead of hanging the recommendation surface", async () => {
        jest.useFakeTimers();
        const deps = dependencies();
        deps.fetchCollaborativeMbids.mockRejectedValue(new Error("down"));
        const observedSignals: AbortSignal[] = [];
        deps.readLastGood.mockImplementation(
            (_userId: string, signal?: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    if (!signal) return;
                    observedSignals.push(signal);
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("aborted")),
                        { once: true },
                    );
                }),
        );
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        const result = adapter.getCandidateBatch("alice-id", 12, 0);
        await jest.advanceTimersByTimeAsync(300);

        await expect(result).resolves.toEqual({
            candidates: [],
            degradedSources: ["listenbrainz"],
        });
        expect(observedSignals).toHaveLength(1);
        expect(observedSignals[0]?.aborted).toBe(true);
        jest.useRealTimers();
    });

    it("does not wait indefinitely for a hanging last-good write", async () => {
        jest.useFakeTimers();
        const deps = dependencies();
        const observedSignals: AbortSignal[] = [];
        deps.writeLastGood.mockImplementation(
            (_userId: string, _tracks: unknown[], signal?: AbortSignal) =>
                new Promise((_resolve, reject) => {
                    if (!signal) return;
                    observedSignals.push(signal);
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("aborted")),
                        { once: true },
                    );
                }),
        );
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        const result = adapter.getCandidateBatch("alice-id", 12, 0);
        await jest.advanceTimersByTimeAsync(300);

        await expect(result).resolves.toEqual({
            candidates: [expect.objectContaining({ id: "yt:video-1" })],
            degradedSources: [],
        });
        expect(observedSignals).toHaveLength(1);
        expect(observedSignals[0]?.aborted).toBe(true);
        jest.useRealTimers();
    });

    it("opens a short circuit after repeated failures without breaking fallback", async () => {
        const deps = dependencies();
        deps.fetchCollaborativeMbids.mockRejectedValue(new Error("down"));
        deps.readLastGood.mockResolvedValue([]);
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        await adapter.getCandidates("alice-id", 12, 0);
        await adapter.getCandidates("alice-id", 12, 0);
        await adapter.getCandidates("alice-id", 12, 0);
        await adapter.getCandidates("alice-id", 12, 0);

        expect(deps.fetchCollaborativeMbids).toHaveBeenCalledTimes(3);
    });

    it("does no provider work for an account without a connection", async () => {
        const deps = dependencies();
        deps.loadConnection.mockResolvedValue(null);
        const adapter = new ListenBrainzRecommendationAdapter(deps);

        await expect(adapter.getCandidates("bob", 12, 0)).resolves.toEqual([]);
        expect(deps.fetchCollaborativeMbids).not.toHaveBeenCalled();
    });
});
