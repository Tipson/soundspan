import { RecommendationEngine } from "../engine";
import type { RecommendationCandidate } from "../types";

function candidate(
    id: string,
    overrides: Partial<RecommendationCandidate> = {},
): RecommendationCandidate {
    return {
        id: `yt:${id}`,
        canonicalKey: `meta:artist-${id}:${id}:180`,
        title: id,
        duration: 180,
        artist: { id: null, name: `artist-${id}` },
        album: { id: null, title: `album-${id}`, coverArt: null },
        source: "youtube",
        provider: { tidalTrackId: null, youtubeVideoId: id },
        streamSource: "youtube",
        youtubeVideoId: id,
        candidateSources: ["youtube-radio"],
        providerPrior: 1,
        ...overrides,
    };
}

describe("unified recommendation engine", () => {
    function dependencies(mode: "baseline" | "shadow" | "active" = "active") {
        return {
            mode,
            hybridRolloutPercent: 100,
            explorationRate: 0.1,
            loadCandidates: jest.fn().mockResolvedValue({
                candidates: [candidate("recent"), candidate("fresh")],
                nextCursor: 1,
                degradedSources: ["listenbrainz"],
            }),
            resolveCanonical: jest.fn(
                async (track: RecommendationCandidate) => ({
                    id: `canonical-${track.id}`,
                    canonicalKey: track.canonicalKey,
                }),
            ),
            loadRecentExposures: jest.fn().mockResolvedValue([
                {
                    canonicalKey: "meta:artist-recent:recent:180",
                    exposedAt: new Date("2026-09-01T08:00:00.000Z"),
                },
            ]),
            loadDislikedCanonicalKeys: jest.fn().mockResolvedValue(new Set()),
            loadTasteContext: jest.fn().mockResolvedValue({
                positiveCentroids: [],
                negativeCentroids: [],
            }),
            recordGeneration: jest
                .fn()
                .mockResolvedValueOnce("served-generation")
                .mockResolvedValueOnce("shadow-generation"),
            scheduleHotSet: jest.fn().mockResolvedValue(undefined),
            now: jest.fn(() => new Date("2026-09-01T12:00:00.000Z")),
        };
    }

    const request = {
        userId: "alice",
        intent: {
            surface: "wave" as const,
            direction: "for-you" as const,
            mood: null,
        },
        sessionId: "session-a",
        cursor: 0,
        limit: 10,
        exclude: [],
    };

    it.each(["baseline", "active", "shadow"] as const)(
        "prepares unseen mood discoveries without presenting unmeasured songs in %s",
        async (mode) => {
            for (const mood of [
                "calm",
                "focus",
                "energetic",
                "workout",
            ] as const) {
                const deps = dependencies(mode);
                deps.loadDislikedCanonicalKeys.mockResolvedValue(
                    new Set([candidate("disliked").canonicalKey]),
                );
                deps.loadCandidates.mockResolvedValue({
                    candidates: [
                        candidate("pending", { lane: "discovery" }),
                        candidate("queued", { lane: "discovery" }),
                        candidate("recent", { lane: "discovery" }),
                        candidate("disliked", { lane: "discovery" }),
                        candidate("album", {
                            lane: "discovery",
                            duration: 3600,
                        }),
                        candidate("known-opposite", {
                            lane: "discovery",
                            audioFeatures: {
                                arousal:
                                    mood === "calm" || mood === "focus"
                                        ? 0.9
                                        : 0.1,
                            },
                        }),
                    ],
                    nextCursor: 1,
                    degradedSources: [],
                });
                const result = await new RecommendationEngine(deps).recommend({
                    ...request,
                    intent: { ...request.intent, mood },
                    exclude: ["yt:queued"],
                });
                expect(result.tracks).toEqual([]);
                expect(
                    deps.recordGeneration.mock.calls.every(
                        ([generation]) =>
                            generation.recommendations.length === 0,
                    ),
                ).toBe(true);
                expect(deps.scheduleHotSet).toHaveBeenCalledTimes(1);
                expect(
                    deps.scheduleHotSet.mock.calls[0][0].candidates.map(
                        (track: RecommendationCandidate) => track.id,
                    ),
                ).toEqual(["yt:pending"]);
            }
        },
    );

    it("lets an analyzed discovery enter the next mood queue after background preparation", async () => {
        const deps = dependencies("baseline");
        const pending = candidate("pending", { lane: "discovery" });
        deps.loadCandidates.mockResolvedValue({
            candidates: [pending],
            nextCursor: 1,
            degradedSources: [],
        });
        let analyzed = false;
        const enrichCandidates = jest.fn(
            async (tracks: RecommendationCandidate[]) =>
                tracks.map((track) =>
                    analyzed
                        ? { ...track, audioFeatures: { arousal: 0.2 } }
                        : track,
                ),
        );
        const engine = new RecommendationEngine({ ...deps, enrichCandidates });
        const calmRequest = {
            ...request,
            intent: { ...request.intent, mood: "calm" as const },
        };
        expect((await engine.recommend(calmRequest)).tracks).toEqual([]);
        expect(deps.scheduleHotSet).toHaveBeenCalledTimes(1);
        analyzed = true;
        expect(
            (await engine.recommend(calmRequest)).tracks.map(
                (track) => track.id,
            ),
        ).toEqual(["yt:pending"]);
        expect(deps.recordGeneration.mock.calls[0][0].recommendations).toEqual(
            [],
        );
        expect(
            deps.recordGeneration.mock.calls[1][0].recommendations[0].track
                .audioFeatures?.arousal,
        ).toBe(0.2);
    });

    it("retains same-artist discoveries for background coverage before admission variety", async () => {
        const deps = dependencies("baseline");
        const discoveries = Array.from({ length: 3 }, (_, index) =>
            candidate(`unknown-${index}`, {
                lane: "discovery",
                artist: { id: null, name: "Unknown artist" },
            }),
        );
        deps.loadCandidates.mockResolvedValue({
            candidates: discoveries,
            nextCursor: 1,
            degradedSources: [],
        });
        const result = await new RecommendationEngine(deps).recommend({
            ...request,
            intent: { ...request.intent, mood: "calm" },
        });
        expect(result.tracks).toEqual([]);
        expect(deps.scheduleHotSet.mock.calls[0][0].candidates).toHaveLength(3);
    });

    it("bounds unknown discovery preparation by distinct recordings", async () => {
        const deps = dependencies("baseline");
        const candidates = Array.from({ length: 150 }, (_, index) =>
            candidate(`pending-${index}`, {
                lane: "discovery",
                artist: { id: null, name: `Artist ${Math.floor(index / 5)}` },
            }),
        );
        deps.loadCandidates.mockResolvedValue({
            candidates: [...candidates, ...candidates],
            nextCursor: 1,
            degradedSources: [],
        });
        const result = await new RecommendationEngine(deps).recommend({
            ...request,
            intent: { ...request.intent, mood: "calm" },
        });
        expect(result.tracks).toEqual([]);
        expect(deps.scheduleHotSet).toHaveBeenCalledTimes(1);
        const admitted: RecommendationCandidate[] =
            deps.scheduleHotSet.mock.calls[0][0].candidates;
        expect(admitted).toHaveLength(48);
        expect(new Set(admitted.map((track) => track.canonicalKey)).size).toBe(
            48,
        );
    });

    it("prepares only unsaved discoveries in the new direction", async () => {
        const deps = dependencies("baseline");
        const saved = candidate("saved", { lane: "discovery" });
        const fresh = candidate("pending", { lane: "discovery" });
        deps.loadCandidates.mockResolvedValue({
            candidates: [saved, fresh],
            nextCursor: 1,
            degradedSources: [],
        });
        const loadSavedCanonicalKeys = jest
            .fn()
            .mockResolvedValue(new Set([saved.canonicalKey]));
        const result = await new RecommendationEngine({
            ...deps,
            loadSavedCanonicalKeys,
        }).recommend({
            ...request,
            intent: { ...request.intent, direction: "new", mood: "calm" },
        });
        expect(result.tracks).toEqual([]);
        expect(
            deps.scheduleHotSet.mock.calls[0][0].candidates.map(
                (track: RecommendationCandidate) => track.id,
            ),
        ).toEqual(["yt:pending"]);
    });

    it.each([
        "exposures",
        "dislikes",
        "features",
        "identity",
        "saved",
    ] as const)(
        "does not prepare unchecked discoveries when the %s lookup fails",
        async (failure) => {
            const deps = dependencies("baseline");
            deps.loadCandidates.mockResolvedValue({
                candidates: [candidate("pending", { lane: "discovery" })],
                nextCursor: 1,
                degradedSources: [],
            });
            const unavailable = new Error("Unavailable");
            if (failure === "exposures")
                deps.loadRecentExposures.mockRejectedValue(unavailable);
            if (failure === "dislikes")
                deps.loadDislikedCanonicalKeys.mockRejectedValue(unavailable);
            if (failure === "identity")
                deps.resolveCanonical.mockRejectedValue(unavailable);
            const enrichCandidates = async (
                tracks: RecommendationCandidate[],
            ) => {
                if (failure === "features") throw unavailable;
                return tracks;
            };
            const loadSavedCanonicalKeys = async () => {
                throw unavailable;
            };
            const result = await new RecommendationEngine({
                ...deps,
                enrichCandidates,
                ...(failure === "saved" ? { loadSavedCanonicalKeys } : {}),
            }).recommend({
                ...request,
                intent: {
                    ...request.intent,
                    mood: "calm",
                    direction: failure === "saved" ? "new" : "for-you",
                },
            });
            expect(result.tracks).toEqual([]);
            expect(deps.scheduleHotSet).not.toHaveBeenCalled();
        },
    );

    it("keeps unavailable collection analysis in its existing account path", async () => {
        const deps = dependencies("baseline");
        deps.loadCandidates.mockResolvedValue({
            candidates: [candidate("pending", { lane: "quickPicks" })],
            nextCursor: 1,
            degradedSources: [],
        });
        const result = await new RecommendationEngine(deps).recommend({
            ...request,
            intent: { ...request.intent, mood: "calm" },
        });
        expect(result.tracks).toEqual([]);
        expect(deps.scheduleHotSet).not.toHaveBeenCalled();
    });

    it.each([
        { surface: "home" as const, mood: "calm" as const },
        { surface: "wave" as const, mood: null },
        { surface: "wave" as const, mood: "favorites" as const },
        { surface: "wave" as const, mood: "forgotten" as const },
    ])(
        "retains ordinary admission outside intensity moods: %j",
        async (intent) => {
            const deps = dependencies("baseline");
            deps.loadCandidates.mockResolvedValue({
                candidates: [candidate("pending", { lane: "discovery" })],
                nextCursor: 1,
                degradedSources: [],
            });
            const result = await new RecommendationEngine(deps).recommend({
                ...request,
                intent: { ...request.intent, ...intent },
            });
            expect(result.tracks.map((track) => track.id)).toEqual([
                "yt:pending",
            ]);
            expect(
                deps.scheduleHotSet.mock.calls[0][0].candidates.map(
                    (track: RecommendationCandidate) => track.id,
                ),
            ).toEqual(["yt:pending"]);
        },
    );

    it("returns a measured queue without waiting for pending mood analysis", async () => {
        const deps = dependencies("baseline");
        deps.loadCandidates.mockResolvedValue({
            candidates: [
                candidate("pending", { lane: "discovery" }),
                candidate("measured", {
                    lane: "discovery",
                    audioFeatures: { arousal: 0.2 },
                }),
            ],
            nextCursor: 1,
            degradedSources: [],
        });
        let finishAnalysis!: () => void;
        deps.scheduleHotSet.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finishAnalysis = resolve;
                }),
        );
        const result = await new RecommendationEngine(deps).recommend({
            ...request,
            intent: { ...request.intent, mood: "calm" },
        });
        expect(result.tracks.map((track) => track.id)).toEqual(["yt:measured"]);
        expect(
            deps.scheduleHotSet.mock.calls[0][0].candidates.map(
                (track: RecommendationCandidate) => track.id,
            ),
        ).toEqual(["yt:pending", "yt:measured"]);
        finishAnalysis();
    });

    it.each(["baseline", "active", "shadow"] as const)(
        "keeps every explicit mood lane eligible in %s, even with a high provider score",
        async (mode) => {
            const deps = dependencies(mode);
            const candidates = [
                "quickPicks",
                "discovery",
                "listenAgain",
            ].flatMap((lane) =>
                [0.2, 0.8, null, NaN, 2].map((arousal, i) =>
                    candidate(`${lane}-${i}`, {
                        lane: lane as RecommendationCandidate["lane"],
                        providerPrior: i * 10,
                        audioFeatures: { arousal, energy: 0.1 },
                    }),
                ),
            );
            deps.loadCandidates.mockResolvedValue({
                candidates,
                nextCursor: 1,
                degradedSources: [],
            });
            for (const [mood, suffix] of [
                ["calm", "0"],
                ["focus", "0"],
                ["energetic", "1"],
                ["workout", "1"],
            ] as const) {
                const result = await new RecommendationEngine(deps).recommend({
                    ...request,
                    intent: { ...request.intent, mood },
                });
                expect(result.tracks).toHaveLength(3);
                expect(
                    result.tracks.every((track) =>
                        track.id.endsWith(`-${suffix}`),
                    ),
                ).toBe(true);
            }
            const neutral = await new RecommendationEngine(deps).recommend({
                ...request,
                limit: 30,
            });
            expect(neutral.tracks.length).toBeGreaterThan(3);
        },
    );

    it.each(["baseline", "active"] as const)(
        "keeps Wave cooldown strict in %s even when lanes cannot be filled",
        async (mode) => {
            const deps = dependencies(mode);
            const result = await new RecommendationEngine(deps).recommend({
                ...request,
                perLaneLimit: 12,
                limit: 36,
            });
            expect(result.tracks.map((track) => track.id)).toEqual([
                "yt:fresh",
            ]);
        },
    );

    it("does not auto-select hour-long mixes but preserves an ordinary long song", async () => {
        const deps = dependencies("baseline");
        deps.loadCandidates.mockResolvedValue({
            candidates: [
                candidate("mix", {
                    title: "The Gym Beats Vol.4 NONSTOP MEGAMIX",
                    duration: 3522,
                }),
                candidate("background", {
                    title: "Attract Positive Energy, Peace & Success",
                    duration: 3629,
                }),
                candidate("song", {
                    title: "Shine On You Crazy Diamond",
                    duration: 810,
                }),
            ],
            nextCursor: 1,
            degradedSources: [],
        });
        const result = await new RecommendationEngine(deps).recommend(request);
        expect(result.tracks.map((track) => track.id)).toEqual(["yt:song"]);
    });

    it("applies mood audio features inside personal candidates in baseline too", async () => {
        const deps = dependencies("baseline");
        deps.loadCandidates.mockResolvedValue({
            candidates: [
                candidate("loud", {
                    audioFeatures: {
                        energy: 1,
                        danceability: 1,
                        instrumentalness: 0,
                    },
                }),
                candidate("quiet", {
                    audioFeatures: {
                        arousal: 0.2,
                        energy: 0.2,
                        danceability: 0.2,
                        instrumentalness: 1,
                    },
                }),
            ],
            nextCursor: 1,
            degradedSources: [],
        });
        const result = await new RecommendationEngine(deps).recommend({
            ...request,
            limit: 1,
            intent: { ...request.intent, mood: "calm" },
        });
        expect(result.tracks[0].id).toBe("yt:quiet");
    });

    it("serves one account-scoped ranked result with persistent anti-repeat", async () => {
        const deps = dependencies();
        const engine = new RecommendationEngine(deps);

        const result = await engine.recommend(request);

        expect(result.tracks.map((track) => track.id)).toEqual(["yt:fresh"]);
        expect(result.generationId).toBe("served-generation");
        expect(result.degradedSources).toEqual(["listenbrainz"]);
        expect(deps.loadRecentExposures).toHaveBeenCalledWith(
            "alice",
            new Date("2026-09-01T12:00:00.000Z"),
        );
        expect(deps.recordGeneration).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "alice",
                served: true,
                algorithm: "hybrid-v2",
            }),
        );
    });

    it("records hybrid shadow ranking while serving the safe baseline", async () => {
        const deps = dependencies("shadow");
        deps.loadRecentExposures.mockResolvedValue([]);
        const engine = new RecommendationEngine(deps);

        const result = await engine.recommend(request);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.tracks.map((track) => track.id)).toEqual([
            "yt:recent",
            "yt:fresh",
        ]);
        expect(deps.recordGeneration).toHaveBeenCalledTimes(2);
        expect(deps.recordGeneration).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                algorithm: "hybrid-v2",
                served: false,
            }),
        );
    });

    it("keeps non-canary accounts on baseline while persisting paired hybrid shadow", async () => {
        const deps = dependencies("active");
        deps.hybridRolloutPercent = 0;
        deps.loadRecentExposures.mockResolvedValue([]);
        const engine = new RecommendationEngine(deps);

        const result = await engine.recommend(request);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.tracks.map((track) => track.id)).toEqual([
            "yt:recent",
            "yt:fresh",
        ]);
        expect(deps.recordGeneration).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ algorithm: "baseline-v1", served: true }),
        );
        expect(deps.recordGeneration).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ algorithm: "hybrid-v2", served: false }),
        );
    });

    it("assigns active rollout per recommendation session instead of pinning one account", async () => {
        const algorithms: string[] = [];
        for (const sessionId of ["session-0", "session-6", "session-6"]) {
            const deps = dependencies("active");
            deps.hybridRolloutPercent = 25;
            deps.loadRecentExposures.mockResolvedValue([]);
            const engine = new RecommendationEngine(deps);

            await engine.recommend({ ...request, sessionId });
            algorithms.push(
                deps.recordGeneration.mock.calls[0]?.[0]?.algorithm,
            );
            expect(deps.recordGeneration).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    context: expect.objectContaining({
                        experimentAssignment: "session-switchback-v1",
                    }),
                }),
            );
        }

        expect(algorithms).toEqual(["baseline-v1", "hybrid-v2", "hybrid-v2"]);
    });

    it("keeps playable fallback candidates when an optional adapter degrades", async () => {
        const deps = dependencies();
        deps.loadCandidates.mockResolvedValue({
            candidates: [candidate("fallback")],
            nextCursor: 2,
            degradedSources: ["listenbrainz", "dclap"],
        });
        const engine = new RecommendationEngine(deps);

        const result = await engine.recommend({ ...request, cursor: 1 });

        expect(result.tracks).toHaveLength(1);
        expect(result.degradedSources).toEqual(["listenbrainz", "dclap"]);
        expect(result.nextCursor).toBe(2);
    });

    it("keeps playable tracks and dislikes when analysis and taste enrichment fail", async () => {
        const deps = {
            ...dependencies(),
            enrichCandidates: jest
                .fn()
                .mockRejectedValue(new Error("analysis unavailable")),
        };
        deps.loadRecentExposures.mockResolvedValue([]);
        deps.loadTasteContext.mockRejectedValue(new Error("taste unavailable"));
        deps.loadDislikedCanonicalKeys.mockResolvedValue(
            new Set(["meta:artist-recent:recent:180"]),
        );

        const result = await new RecommendationEngine(deps).recommend(request);

        expect(result.tracks.map((track) => track.id)).toEqual(["yt:fresh"]);
        expect(result.degradedSources).toEqual(
            expect.arrayContaining(["canonical-features", "taste-profile"]),
        );
        expect(result.tracks[0].embedding).toBeUndefined();
    });

    it("serves both arms at fifty percent without excluding tracks lacking embeddings", async () => {
        const algorithms = new Set<string>();
        for (let index = 0; index < 32; index++) {
            const deps = dependencies();
            deps.hybridRolloutPercent = 50;
            deps.loadRecentExposures.mockResolvedValue([]);
            const result = await new RecommendationEngine(deps).recommend({
                ...request,
                sessionId: `rollout-${index}`,
            });
            expect(result.tracks).toHaveLength(2);
            expect(
                result.tracks.every((track) => track.embedding === undefined),
            ).toBe(true);
            algorithms.add(deps.recordGeneration.mock.calls[0]?.[0]?.algorithm);
        }
        expect(algorithms).toEqual(new Set(["baseline-v1", "hybrid-v2"]));
    });

    it("keeps the served result available when telemetry rejects it", async () => {
        const deps = dependencies();
        deps.loadRecentExposures.mockResolvedValue([]);
        const metrics = {
            recordGeneration: jest.fn(() => {
                throw new Error("metrics unavailable");
            }),
        };
        const engine = new RecommendationEngine(deps, metrics);

        await expect(engine.recommend(request)).resolves.toEqual(
            expect.objectContaining({ generationId: "served-generation" }),
        );
        expect(metrics.recordGeneration).toHaveBeenCalledWith(
            expect.objectContaining({
                algorithm: "hybrid-v2",
                served: true,
                degradedSourceCount: 1,
            }),
        );
    });

    it("enriches resolved canonical candidates in one optional feature-store pass", async () => {
        const deps = {
            ...dependencies(),
            enrichCandidates: jest.fn(
                async (tracks: RecommendationCandidate[]) =>
                    tracks.map((track) => ({
                        ...track,
                        embedding: [1, 0],
                        audioFeatures: { energy: 0.8 },
                    })),
            ),
        };
        deps.loadRecentExposures.mockResolvedValue([]);
        const engine = new RecommendationEngine(deps);

        const result = await engine.recommend(request);

        expect(deps.enrichCandidates).toHaveBeenCalledTimes(1);
        expect(result.tracks[0]).toEqual(
            expect.objectContaining({
                embedding: [1, 0],
                audioFeatures: { energy: 0.8 },
            }),
        );
    });

    it.each(["baseline", "active"] as const)(
        "excludes alternate uploads of a saved recording from Discoveries in %s",
        async (mode) => {
            const deps = {
                ...dependencies(mode),
                loadSavedCanonicalKeys: jest
                    .fn()
                    .mockResolvedValue(new Set(["saved-recording"])),
            };
            deps.loadCandidates.mockResolvedValue({
                candidates: [
                    candidate("alternate-upload", {
                        canonicalKey: "saved-recording",
                        lane: "discovery",
                    }),
                    candidate("unheard", {
                        artist: { id: null, name: "Artist of saved recording" },
                        lane: "discovery",
                    }),
                ],
                nextCursor: 1,
                degradedSources: [],
            });
            const result = await new RecommendationEngine(deps).recommend({
                ...request,
                intent: { ...request.intent, direction: "new" },
            });
            expect(result.tracks.map((t) => t.id)).toEqual(["yt:unheard"]);
            expect(deps.loadSavedCanonicalKeys).toHaveBeenCalledWith(
                "alice",
                expect.any(Array),
            );
        },
    );

    it("does not query saved exclusions for the ordinary mix", async () => {
        const deps = { ...dependencies(), loadSavedCanonicalKeys: jest.fn() };
        await new RecommendationEngine(deps).recommend(request);
        expect(deps.loadSavedCanonicalKeys).not.toHaveBeenCalled();
    });

    it("does not present unchecked discoveries when saved identity lookup fails", async () => {
        const deps = {
            ...dependencies("baseline"),
            loadSavedCanonicalKeys: jest
                .fn()
                .mockRejectedValue(new Error("DB unavailable")),
        };
        const result = await new RecommendationEngine(deps).recommend({
            ...request,
            intent: { ...request.intent, direction: "new" },
        });
        expect(result.tracks).toEqual([]);
        expect(result.degradedSources).toContain("saved-recordings");
    });
});
