import {
    UnifiedRecommendationService,
    type UnifiedRecommendationDependencies,
} from "../recommendationService";
import { WaveSequenceError } from "../waveSequence";
import type { RecordEngineGenerationInput } from "../engine";

const now = new Date("2026-11-17T00:00:00.000Z");
const ids = [
    "AAAAAAAAAA1",
    "AAAAAAAAAA2",
    "DDDDDDDDDD1",
    "BBBBBBBBBB1",
    "EEEEEEEEEE1",
    "CCCCCCCCCC1",
];
function track(id: string, artist = id[0]) {
    return {
        id: `yt:${id}`,
        title: id,
        duration: 180,
        trackNo: null,
        artist: { id: null, name: artist },
        album: {
            id: null,
            title: "Album",
            coverArt: "",
            artist: { id: null, name: artist },
        },
        source: "youtube" as const,
        streamSource: "youtube" as const,
        youtubeVideoId: id,
        provider: { tidalTrackId: null, youtubeVideoId: id },
    };
}
const input = {
    userId: "alice",
    sessionId: "wave-tab",
    surface: "wave" as const,
    direction: "for-you" as const,
    mood: null,
    language: "any" as const,
    cursor: 0,
    limit: 6,
    excludeVideoIds: [],
    waveSequenceVersion: 1 as const,
};
function fixture(overrides: Partial<UnifiedRecommendationDependencies> = {}) {
    const generations = new Map<string, RecordEngineGenerationInput>();
    const deps = {
        mode: "baseline" as const,
        hybridRolloutPercent: 100,
        explorationRate: 0,
        waveSequenceEnabled: true,
        loadPersonalizedFeed: jest.fn().mockImplementation(async () => ({
            shelves: {
                listenAgain: [track(ids[0]), track(ids[1])],
                quickPicks: [track(ids[2]), track(ids[3])],
                discovery: [track(ids[4]), track(ids[5])],
            },
            degraded: false,
            reason: null,
            seedCount: 2,
            nextCursor: 7,
        })),
        resolveCanonical: jest.fn(
            async (c: { id: string; canonicalKey: string }) => ({
                id: c.id,
                canonicalKey: c.canonicalKey,
            }),
        ),
        loadRecentExposures: jest.fn(async () => []),
        loadDislikedCanonicalKeys: jest.fn(async () => new Set<string>()),
        loadTasteContext: jest.fn(async () => ({
            positiveCentroids: [],
            negativeCentroids: [],
        })),
        recordGeneration: jest.fn(async (row: RecordEngineGenerationInput) => {
            const id = `generation-${generations.size + 1}`;
            generations.set(id, row);
            return id;
        }),
        loadWaveSequenceGeneration: jest.fn(
            async (id: string, _userId: string, _sessionId: string) => {
                const row = generations.get(id);
                return row
                    ? { ...row, id, createdAt: now, context: row.context }
                    : null;
            },
        ),
        scheduleHotSet: jest.fn(async () => {}),
        loadSimilarCandidates: jest.fn(async () => ({
            candidates: [],
            nextCursor: 0,
            degradedSources: [],
        })),
        now: () => now,
    };
    return {
        deps,
        generations,
        service: new UnifiedRecommendationService({ ...deps, ...overrides }),
    };
}

describe("opt-in ordered Wave service", () => {
    it("retains an admitted library row in the exact ordered DTO instead of losing it in legacy shelves", async () => {
        const { service } = fixture({
            enrichCandidates: async (rows) =>
                rows.map((row, index) =>
                    index === 0
                        ? {
                              ...row,
                              id: "local-library-1",
                              source: "library",
                              streamSource: "library",
                              youtubeVideoId: undefined,
                              provider: {
                                  youtubeVideoId: null,
                                  tidalTrackId: null,
                              },
                          }
                        : row,
                ),
        });
        const result = await service.getPersonalizedFeed(input);
        const local = result.orderedWave!.items.find(
            (row) => row.track.id === "local-library-1",
        )!;
        expect(local.track.source).toBe("library");
        expect(local.track.provider.youtubeVideoId).toBeNull();
        expect(local.track.streamSource).toBe("library");
        expect(local.track.album).toHaveProperty("artist", local.track.artist);
        expect(result.orderedWave!.items).toHaveLength(6);
    });
    it("rejects conflicting library/YouTube backing before the only generation write", async () => {
        const { service, deps } = fixture({
            enrichCandidates: async (rows) =>
                rows.map((row, index) =>
                    index === 0
                        ? {
                              ...row,
                              id: "local-library-1",
                              source: "library",
                              streamSource: "library",
                          }
                        : row,
                ),
        });
        await expect(service.getPersonalizedFeed(input)).rejects.toBeInstanceOf(
            WaveSequenceError,
        );
        expect(deps.recordGeneration).not.toHaveBeenCalled();
    });
    it.each([false, true])(
        "keeps legacy shelves without explicit opt-in (flag %s)",
        async (enabled) => {
            const { service, deps } = fixture({ waveSequenceEnabled: enabled });
            const { waveSequenceVersion: _version, ...legacy } = input;
            const result = await service.getPersonalizedFeed(legacy);
            expect(result).not.toHaveProperty("orderedWave");
            expect(
                result.shelves.listenAgain.map((row) => row.youtubeVideoId),
            ).toEqual(ids.slice(0, 2));
            expect(deps.loadWaveSequenceGeneration).not.toHaveBeenCalled();
            expect(
                deps.recordGeneration.mock.calls[0][0].context,
            ).not.toHaveProperty("orderedWave");
        },
    );

    it("returns a single bounded order across shelves, exactly matching its served generation", async () => {
        const { service, deps } = fixture();
        const result = await service.getPersonalizedFeed(input);
        expect(
            result.orderedWave?.items.map((row) => row.track.youtubeVideoId),
        ).toEqual([ids[0], ids[2], ids[3], ids[1], ids[4], ids[5]]);
        expect(result.orderedWave?.items.map((row) => row.position)).toEqual([
            0, 1, 2, 3, 4, 5,
        ]);
        expect(result.orderedWave?.tail).toEqual([
            { source: "youtube", id: ids[4], position: 4 },
            { source: "youtube", id: ids[5], position: 5 },
        ]);
        expect(deps.recordGeneration).toHaveBeenCalledTimes(1);
        const stored = deps.recordGeneration.mock.calls[0][0];
        expect(stored.recommendations.map((row) => row.track.id)).toEqual(
            result.orderedWave?.items.map((row) => row.track.id),
        );
        expect(stored.context?.orderedWave).toEqual(
            expect.objectContaining({ nextPosition: 6, nextSourceCursor: 7 }),
        );
        expect(JSON.stringify(result.orderedWave)).not.toMatch(
            /artistKey|candidateSources|embedding|providerPrior|canonicalKey/,
        );
        expect(deps.loadWaveSequenceGeneration).not.toHaveBeenCalled();
    });

    it("continues from the full owned tail and trusted source cursor before selecting candidates", async () => {
        const { service, deps } = fixture();
        const first = await service.getPersonalizedFeed(input);
        deps.loadPersonalizedFeed.mockResolvedValueOnce({
            shelves: {
                listenAgain: [],
                quickPicks: [],
                discovery: [
                    track("CCCCCCCCCC2"),
                    track("EEEEEEEEEE2"),
                    track("DDDDDDDDDD2"),
                ],
            },
            degraded: false,
            reason: null,
            seedCount: 1,
            nextCursor: 8,
        });
        const second = await service.getPersonalizedFeed({
            ...input,
            cursor: 999,
            waveSequenceCursor: first.orderedWave!.nextCursor,
            waveSequenceTail: first.orderedWave!.tail,
        });
        expect(deps.loadWaveSequenceGeneration).toHaveBeenCalledTimes(1);
        expect(deps.loadWaveSequenceGeneration).toHaveBeenCalledWith(
            first.generationId,
            "alice",
            "wave-tab",
        );
        expect(deps.loadPersonalizedFeed).toHaveBeenLastCalledWith(
            "alice",
            expect.any(Number),
            expect.objectContaining({ cursor: 7 }),
        );
        expect(second.orderedWave?.sequenceId).toBe(
            first.orderedWave?.sequenceId,
        );
        expect(
            second.orderedWave?.items.map((row) => row.track.artist.name),
        ).toEqual(["D", "E", "C"]);
        expect(second.orderedWave?.items.map((row) => row.position)).toEqual([
            6, 7, 8,
        ]);
        expect(second.orderedWave?.startPosition).toBe(6);
    });

    it.each([
        "flag",
        "diagnostic",
        "surface",
        "tail-without-cursor",
        "malformed-cursor",
    ])(
        "rejects %s before loading candidates or writing exposures",
        async (kind) => {
            const { service, deps } = fixture({
                waveSequenceEnabled: kind !== "flag",
            });
            const request = {
                ...input,
                ...(kind === "diagnostic" ? { diagnostic: true } : {}),
                ...(kind === "surface" ? { surface: "home" as const } : {}),
                ...(kind === "tail-without-cursor"
                    ? {
                          waveSequenceTail: [
                              { source: "youtube", id: ids[0], position: 0 },
                          ],
                      }
                    : {}),
                ...(kind === "malformed-cursor"
                    ? { waveSequenceCursor: "not-json", waveSequenceTail: [] }
                    : {}),
            };
            await expect(
                service.getPersonalizedFeed(request),
            ).rejects.toBeInstanceOf(WaveSequenceError);
            expect(deps.loadPersonalizedFeed).not.toHaveBeenCalled();
            expect(deps.recordGeneration).not.toHaveBeenCalled();
        },
    );

    it.each([
        "reordered",
        "partial",
        "foreign",
        "expired",
        "intent",
        "missing-generation",
        "artist-injection",
    ])("rejects %s continuation before new candidates", async (kind) => {
        const { service, deps, generations } = fixture();
        const first = await service.getPersonalizedFeed(input);
        const tail = first.orderedWave!.tail;
        if (kind === "missing-generation") generations.clear();
        if (kind === "foreign")
            generations.get(first.generationId)!.userId = "bob";
        if (kind === "expired")
            deps.loadWaveSequenceGeneration.mockImplementationOnce(
                async () => ({
                    ...generations.get(first.generationId)!,
                    context: generations.get(first.generationId)!.context,
                    id: first.generationId,
                    createdAt: new Date(now.getTime() - 86_400_001),
                }),
            );
        deps.loadPersonalizedFeed.mockClear();
        deps.recordGeneration.mockClear();
        await expect(
            service.getPersonalizedFeed({
                ...input,
                ...(kind === "intent" ? { direction: "new" as const } : {}),
                waveSequenceCursor: first.orderedWave!.nextCursor,
                waveSequenceTail:
                    kind === "reordered"
                        ? [...tail].reverse()
                        : kind === "partial"
                          ? tail.slice(1)
                          : kind === "artist-injection"
                            ? tail.map((row) => ({
                                  ...row,
                                  artistKey: "trusted?",
                              }))
                            : tail,
            }),
        ).rejects.toBeInstanceOf(WaveSequenceError);
        expect(deps.loadPersonalizedFeed).not.toHaveBeenCalled();
        expect(deps.recordGeneration).not.toHaveBeenCalled();
    });

    it("keeps the last two trusted positions across an empty page", async () => {
        const { service, deps } = fixture();
        const first = await service.getPersonalizedFeed(input);
        deps.loadPersonalizedFeed.mockResolvedValueOnce({
            shelves: { listenAgain: [], quickPicks: [], discovery: [] },
            degraded: false,
            reason: null,
            seedCount: 1,
            nextCursor: 8,
        });
        const second = await service.getPersonalizedFeed({
            ...input,
            waveSequenceCursor: first.orderedWave!.nextCursor,
            waveSequenceTail: first.orderedWave!.tail,
        });
        expect(second.orderedWave?.items).toEqual([]);
        expect(second.orderedWave?.startPosition).toBe(6);
        expect(second.orderedWave?.tail).toEqual(first.orderedWave?.tail);
        expect(second.orderedWave?.nextCursor).not.toBe(
            first.orderedWave?.nextCursor,
        );
    });
});
