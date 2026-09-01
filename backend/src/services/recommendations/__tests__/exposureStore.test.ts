import { RecommendationExposureStore } from "../exposureStore";
import type { RecommendationCandidate } from "../types";

const track: RecommendationCandidate = {
    id: "yt:one",
    canonicalKey: "mbid:one",
    canonicalRecordingId: "canonical-1",
    title: "One",
    duration: 180,
    artist: { id: null, name: "Artist" },
    album: { id: null, title: "Album", coverArt: null },
    source: "youtube",
    provider: { tidalTrackId: null, youtubeVideoId: "one" },
    streamSource: "youtube",
    youtubeVideoId: "one",
    candidateSources: ["listenbrainz", "youtube-radio"],
    providerPrior: 1,
};

describe("recommendation exposure store", () => {
    it("writes one generation with account-scoped exposure attribution", async () => {
        const createGeneration = jest.fn().mockResolvedValue({ id: "gen-1" });
        const store = new RecommendationExposureStore({
            createGeneration,
            loadRecentExposures: jest.fn(),
            findAttributableExposure: jest.fn(),
            updateExposure: jest.fn(),
        });

        const generationId = await store.record({
            userId: "alice",
            sessionId: "session-a",
            surface: "wave",
            direction: "for-you",
            mood: null,
            cursor: 0,
            algorithm: "hybrid-v2",
            served: true,
            degradedSources: ["listenbrainz"],
            latencyMs: 42,
            recommendations: [{ track, score: 1.5 }],
        });

        expect(generationId).toBe("gen-1");
        expect(createGeneration).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "alice",
                exposures: [
                    expect.objectContaining({
                        userId: "alice",
                        canonicalKey: "mbid:one",
                        artistKey: "artist",
                        provider: "youtube",
                        providerTrackId: "one",
                        source: "listenbrainz+youtube-radio",
                    }),
                ],
            }),
        );
    });

    it("loads only the requested account's seven-day history", async () => {
        const loadRecentExposures = jest
            .fn()
            .mockResolvedValue([
                { canonicalKey: "mbid:one", exposedAt: new Date() },
            ]);
        const store = new RecommendationExposureStore({
            createGeneration: jest.fn(),
            loadRecentExposures,
            findAttributableExposure: jest.fn(),
            updateExposure: jest.fn(),
        });

        await store.loadRecent("bob", new Date("2026-09-01T12:00:00.000Z"));

        expect(loadRecentExposures).toHaveBeenCalledWith(
            "bob",
            new Date("2026-08-25T12:00:00.000Z"),
        );
    });

    it("attributes a technical failure without converting it into taste", async () => {
        const updateExposure = jest.fn().mockResolvedValue(undefined);
        const findAttributableExposure = jest
            .fn()
            .mockResolvedValue({ id: "exposure-1" });
        const store = new RecommendationExposureStore({
            createGeneration: jest.fn(),
            loadRecentExposures: jest.fn(),
            findAttributableExposure,
            updateExposure,
        });

        await store.attributePlayback({
            userId: "alice",
            provider: "youtube",
            providerTrackId: "one",
            playedAt: new Date("2026-09-01T12:00:00.000Z"),
            listenedSeconds: 0,
            completionRatio: 0,
            outcome: "failed",
        });

        expect(updateExposure).toHaveBeenCalledWith("exposure-1", {
            playedAt: new Date("2026-09-01T12:00:00.000Z"),
            listenedSeconds: 0,
            completionRatio: 0,
            outcome: "failed",
        });
        expect(findAttributableExposure).toHaveBeenCalledWith(
            "alice",
            "youtube",
            "one",
            new Date("2026-08-25T12:00:00.000Z"),
            new Date("2026-09-01T12:00:00.000Z"),
        );
        expect(store.tasteDeltaForOutcome("failed", 0, 0)).toBe(0);
        expect(store.tasteDeltaForOutcome("skipped", 0.05, 8)).toBeLessThan(0);
    });

    it("does not fail persistence or attribution when telemetry throws", async () => {
        const updateExposure = jest.fn().mockResolvedValue(undefined);
        const metrics = {
            recordExposures: jest.fn(() => {
                throw new Error("metrics unavailable");
            }),
            recordPlaybackOutcome: jest.fn(() => {
                throw new Error("metrics unavailable");
            }),
        };
        const store = new RecommendationExposureStore(
            {
                createGeneration: jest.fn().mockResolvedValue({ id: "gen-1" }),
                loadRecentExposures: jest.fn(),
                findAttributableExposure: jest
                    .fn()
                    .mockResolvedValue({ id: "exposure-1" }),
                updateExposure,
            },
            metrics,
        );

        await expect(
            store.record({
                userId: "alice",
                sessionId: "session-a",
                surface: "wave",
                direction: "for-you",
                mood: null,
                cursor: 0,
                algorithm: "hybrid-v2",
                served: true,
                degradedSources: [],
                latencyMs: 10,
                recommendations: [{ track, score: 1 }],
            }),
        ).resolves.toBe("gen-1");
        await expect(
            store.attributePlayback({
                userId: "alice",
                provider: "youtube",
                providerTrackId: "one",
                playedAt: new Date("2026-09-01T12:00:00.000Z"),
                listenedSeconds: 0,
                completionRatio: 0,
                outcome: "failed",
            }),
        ).resolves.toBeUndefined();
        expect(updateExposure).toHaveBeenCalledTimes(1);
    });
});
