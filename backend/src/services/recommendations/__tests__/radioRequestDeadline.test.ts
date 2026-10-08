const mockSearch = jest.fn();
const mockGetRadio = jest.fn();
jest.mock("../../youtubeMusic", () => ({
    ytMusicService: { searchCanonical: mockSearch, getRadio: mockGetRadio },
}));
jest.mock("../../../utils/db", () => ({ prisma: {} }));

import { UnifiedRecommendationService } from "../recommendationService";
import { buildRemoteArtistRadio } from "../../playlistRemoteRadio";
import type { RadioContinuationInput } from "../radioContinuation";
import type { RecommendationCandidate } from "../types";

const input: RadioContinuationInput = {
    userId: "alice",
    sessionId: "original-station",
    cursor: 0,
    limit: 25,
    radioOrigin: { kind: "artist", source: "discovery", name: "Artist" },
    exclude: [],
};
const track: RecommendationCandidate = {
    id: "yt:next0000001",
    canonicalKey: "meta:related:recommendation:180",
    title: "Recommendation",
    duration: 180,
    artist: { id: null, name: "Related Artist" },
    album: { id: null, title: "Album", coverArt: null },
    source: "youtube",
    streamSource: "youtube",
    provider: { tidalTrackId: null, youtubeVideoId: "next0000001" },
    candidateSources: ["original-radio"],
    providerPrior: 1,
};
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const batch = { candidates: [track], nextCursor: 1, degradedSources: [] };
function setup() {
    const deps = {
        mode: "baseline" as const,
        hybridRolloutPercent: 0,
        explorationRate: 0,
        loadRadioCandidates: jest.fn().mockResolvedValue(batch),
        loadPersonalizedFeed: jest.fn(),
        loadSimilarCandidates: jest.fn(),
        resolveCanonical: jest.fn(async (c: RecommendationCandidate) => ({
            id: "canonical",
            canonicalKey: c.canonicalKey,
        })),
        loadRecentExposures: jest.fn().mockResolvedValue([]),
        loadDislikedCanonicalKeys: jest.fn().mockResolvedValue(new Set()),
        loadTasteContext: jest.fn().mockResolvedValue({
            positiveCentroids: [],
            negativeCentroids: [],
        }),
        recordGeneration: jest.fn().mockResolvedValue("owned-generation"),
        scheduleHotSet: jest.fn().mockResolvedValue(undefined),
        now: () => new Date(),
    };
    return { deps, service: new UnifiedRecommendationService(deps) };
}
const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};
function observe<T>(promise: Promise<T>) {
    const state: { value?: T; error?: unknown; settled: boolean } = {
        settled: false,
    };
    const done = promise.then(
        (value) => {
            state.value = value;
            state.settled = true;
        },
        (error: unknown) => {
            state.error = error;
            state.settled = true;
        },
    );
    return { state, done };
}
beforeEach(() => {
    jest.useFakeTimers();
    jest.resetAllMocks();
});
afterEach(() => {
    jest.useRealTimers();
});

test("bounds actual artist search plus radio and never persists its late result", async () => {
    const { deps, service } = setup();
    mockSearch.mockImplementation(
        () =>
            new Promise((resolve) =>
                setTimeout(
                    () =>
                        resolve({
                            results: [
                                {
                                    provider: "ytmusic",
                                    artistName: "Artist",
                                    providerTrackId: "seed0000001",
                                },
                            ],
                        }),
                    8_000,
                ),
            ),
    );
    mockGetRadio.mockImplementation(
        () =>
            new Promise((resolve) =>
                setTimeout(
                    () =>
                        resolve({
                            tracks: [
                                {
                                    videoId: "next0000001",
                                    title: "Recommendation",
                                    artist: "Related Artist",
                                    album: "Album",
                                    duration: 180,
                                },
                            ],
                        }),
                    13_000,
                ),
            ),
    );
    deps.loadRadioCandidates.mockImplementation(async (radioInput) => {
        await buildRemoteArtistRadio("Artist", 100, undefined, {
            execution: radioInput.execution,
        } as Parameters<typeof buildRemoteArtistRadio>[3]);
        return batch;
    });
    const result = observe(service.recommendRadio(input));
    await flush();
    await jest.advanceTimersByTimeAsync(8_000);
    expect(mockGetRadio).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    const atDeadline = { ...result.state };
    await jest.advanceTimersByTimeAsync(8_000);
    await result.done;
    expect(atDeadline.settled).toBe(true);
    expect(atDeadline.error).toMatchObject({ code: "RADIO_REQUEST_TIMEOUT" });
    expect(deps.resolveCanonical).not.toHaveBeenCalled();
    expect(deps.recordGeneration).not.toHaveBeenCalled();
    expect(deps.scheduleHotSet).not.toHaveBeenCalled();
    expect(mockGetRadio.mock.calls[0]).toEqual(["seed0000001", 100]);
});

test("deadline during canonical resolution cannot become served generation after release", async () => {
    const { deps, service } = setup();
    const held = deferred<{ id: string; canonicalKey: string }>();
    deps.resolveCanonical.mockReturnValue(held.promise);
    const result = observe(service.recommendRadio(input));
    await flush();
    expect(deps.resolveCanonical).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(13_000);
    const atDeadline = { ...result.state };
    held.resolve({ id: "canonical", canonicalKey: track.canonicalKey });
    await result.done;
    await flush();
    expect(atDeadline.settled).toBe(true);
    expect(atDeadline.error).toMatchObject({ code: "RADIO_REQUEST_TIMEOUT" });
    expect(deps.loadRecentExposures).not.toHaveBeenCalled();
    expect(deps.recordGeneration).not.toHaveBeenCalled();
});

test("cancelled owner stops while another request sharing the same pool can finish", async () => {
    const { deps, service } = setup();
    const held = deferred<typeof batch>();
    deps.loadRadioCandidates.mockReturnValue(held.promise);
    const controller = new AbortController();
    const recommend = service.recommendRadio.bind(service) as (
        value: RadioContinuationInput,
        options?: { signal?: AbortSignal },
    ) => ReturnType<typeof service.recommendRadio>;
    const cancelled = observe(recommend(input, { signal: controller.signal }));
    const other = observe(recommend({ ...input, userId: "bob" }));
    await flush();
    controller.abort();
    await flush();
    const beforeRelease = { ...cancelled.state };
    held.resolve(batch);
    await Promise.all([cancelled.done, other.done]);
    await flush();
    expect(beforeRelease.error).toMatchObject({
        code: "RADIO_REQUEST_CANCELLED",
    });
    expect(other.state.value).toMatchObject({
        generationId: "owned-generation",
    });
    expect(deps.recordGeneration).toHaveBeenCalledTimes(1);
    expect(deps.recordGeneration.mock.calls[0][0]).toMatchObject({
        userId: "bob",
        served: true,
    });
});

test("successful empty and diagnostic results retain station cursor and timer cleanup", async () => {
    const { deps, service } = setup();
    deps.loadRadioCandidates.mockResolvedValue({ ...batch, candidates: [] });
    const result = await service.recommendRadio({ ...input, diagnostic: true });
    expect(result).toMatchObject({
        radioOrigin: input.radioOrigin,
        nextCursor: 1,
        generationId: "diagnostic-recommendation",
        tracks: [],
        degraded: false,
    });
    expect(deps.recordGeneration).not.toHaveBeenCalled();
    expect(deps.scheduleHotSet).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
});
