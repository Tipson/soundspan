import { RecommendationShadowEvaluationService } from "../shadowEvaluation";

describe("recommendation shadow evaluation", () => {
    const since = new Date("2026-08-31T12:00:00.000Z");
    const until = new Date("2026-09-01T12:00:00.000Z");

    it("compares paired baseline and hybrid ranks and summarizes served engagement", async () => {
        const loadGenerations = jest.fn().mockResolvedValue([
            {
                id: "baseline-1",
                userId: "alice",
                sessionId: "session-a",
                surface: "wave",
                direction: "for-you",
                mood: null,
                cursor: 0,
                algorithm: "baseline-v1",
                served: true,
                latencyMs: 100,
                createdAt: new Date("2026-09-01T10:00:00.000Z"),
                exposures: [
                    {
                        canonicalKey: "a",
                        playedAt: new Date("2026-09-01T10:01:00.000Z"),
                        completionRatio: 0.95,
                        outcome: "completed",
                    },
                    {
                        canonicalKey: "b",
                        playedAt: new Date("2026-09-01T10:02:00.000Z"),
                        completionRatio: 0.1,
                        outcome: "skipped",
                    },
                ],
            },
            {
                id: "hybrid-shadow-1",
                userId: "alice",
                sessionId: "session-a",
                surface: "wave",
                direction: "for-you",
                mood: null,
                cursor: 0,
                algorithm: "hybrid-v2",
                served: false,
                latencyMs: 150,
                createdAt: new Date("2026-09-01T10:00:00.010Z"),
                exposures: [
                    {
                        canonicalKey: "b",
                        playedAt: null,
                        completionRatio: null,
                        outcome: null,
                    },
                    {
                        canonicalKey: "c",
                        playedAt: null,
                        completionRatio: null,
                        outcome: null,
                    },
                ],
            },
            {
                id: "hybrid-active-1",
                userId: "alice",
                sessionId: "session-b",
                surface: "home",
                direction: "new",
                mood: null,
                cursor: 0,
                algorithm: "hybrid-v2",
                served: true,
                latencyMs: 250,
                createdAt: new Date("2026-09-01T11:00:00.000Z"),
                exposures: [
                    {
                        canonicalKey: "d",
                        playedAt: new Date("2026-09-01T11:01:00.000Z"),
                        completionRatio: 0.75,
                        outcome: "meaningful",
                    },
                ],
            },
        ]);
        const service = new RecommendationShadowEvaluationService({
            loadGenerations,
        });

        const report = await service.evaluate({ since, until });

        expect(loadGenerations).toHaveBeenCalledWith(
            new Date("2026-08-24T12:00:00.000Z"),
            until,
        );
        expect(report.algorithms.baseline).toEqual(
            expect.objectContaining({
                generationCount: 1,
                servedGenerationCount: 1,
                shadowGenerationCount: 0,
                coverageRate: 1,
                meanExposureCount: 2,
            }),
        );
        expect(report.algorithms.baseline.engagement).toEqual({
            exposureCount: 2,
            attributedCount: 2,
            playbackRate: 1,
            completionRate: 0.5,
            earlySkipRate: 0.5,
            meanCompletionRatio: 0.525,
        });
        expect(report.algorithms.baseline.latency).toEqual({
            sampleCount: 1,
            meanMs: 100,
            p95Ms: 100,
        });
        expect(report.algorithms.hybrid.latency).toEqual({
            sampleCount: 2,
            meanMs: 200,
            p95Ms: 250,
        });
        expect(report.algorithms.hybrid.engagement).toEqual({
            exposureCount: 1,
            attributedCount: 1,
            playbackRate: 1,
            completionRate: 0,
            earlySkipRate: 0,
            meanCompletionRatio: 0.75,
        });
        expect(report.pairedShadow).toEqual({
            pairCount: 1,
            meanJaccardOverlap: 1 / 3,
            meanBaselineCoverage: 0.5,
        });
    });

    it("returns explicit zero coverage and unavailable engagement for an empty window", async () => {
        const service = new RecommendationShadowEvaluationService({
            loadGenerations: jest.fn().mockResolvedValue([]),
            loadDataQuality: jest.fn().mockResolvedValue({
                canonicalRecordingCount: 100,
                isrcCount: 40,
                recordingMbidCount: 30,
                fingerprintCount: 20,
                scalarAnalysisCount: 10,
                embeddingCount: 5,
                viewedImpressionCount: 12,
                participatingAccountCount: 3,
            }),
        });

        const report = await service.evaluate({ since, until });

        expect(report.algorithms.baseline.coverageRate).toBe(0);
        expect(report.algorithms.hybrid.coverageRate).toBe(0);
        expect(report.algorithms.baseline.engagement).toBeNull();
        expect(report.algorithms.hybrid.engagement).toBeNull();
        expect(report.algorithms.baseline.latency).toEqual({
            sampleCount: 0,
            meanMs: 0,
            p95Ms: 0,
        });
        expect(report.pairedShadow.pairCount).toBe(0);
        expect(report.dataQuality).toEqual({
            canonicalRecordingCount: 100,
            identity: {
                isrcCount: 40,
                isrcCoverageRate: 0.4,
                recordingMbidCount: 30,
                recordingMbidCoverageRate: 0.3,
                fingerprintCount: 20,
                fingerprintCoverageRate: 0.2,
            },
            analysis: {
                scalarAnalysisCount: 10,
                scalarAnalysisCoverageRate: 0.1,
                embeddingCount: 5,
                embeddingCoverageRate: 0.05,
            },
            experiment: {
                viewedImpressionCount: 12,
                participatingAccountCount: 3,
            },
        });
    });

    it("excludes server-generated cards that never entered the viewport", async () => {
        const service = new RecommendationShadowEvaluationService({
            loadGenerations: jest.fn().mockResolvedValue([
                {
                    id: "baseline-viewed",
                    userId: "alice",
                    sessionId: "session-a",
                    surface: "home",
                    direction: "for-you",
                    mood: null,
                    cursor: 0,
                    algorithm: "baseline-v1",
                    served: true,
                    latencyMs: 10,
                    createdAt: new Date("2026-09-01T10:00:00.000Z"),
                    exposures: [
                        {
                            canonicalKey: "not-visible",
                            artistKey: "artist-a",
                            exposedAt: new Date("2026-09-01T10:00:00.000Z"),
                            viewedAt: null,
                            playedAt: null,
                            listenedSeconds: null,
                            completionRatio: null,
                            outcome: null,
                        },
                        {
                            canonicalKey: "visible",
                            artistKey: "artist-b",
                            exposedAt: new Date("2026-09-01T10:00:01.000Z"),
                            viewedAt: new Date("2026-09-01T10:00:02.000Z"),
                            playedAt: null,
                            listenedSeconds: null,
                            completionRatio: null,
                            outcome: null,
                        },
                    ],
                },
            ]),
        });

        const report = await service.evaluate({ since, until });

        expect(report.algorithms.baseline.engagement?.exposureCount).toBe(1);
        expect(report.algorithms.baseline.engagement?.playbackRate).toBe(0);
    });

    it("does not classify missing duration as an early skip by itself", async () => {
        const service = new RecommendationShadowEvaluationService({
            loadGenerations: jest.fn().mockResolvedValue([
                {
                    id: "baseline-1",
                    userId: "alice",
                    sessionId: "session-a",
                    surface: "wave",
                    direction: "for-you",
                    mood: null,
                    cursor: 0,
                    algorithm: "baseline-v1",
                    served: true,
                    createdAt: new Date("2026-09-01T10:00:00.000Z"),
                    exposures: [
                        {
                            canonicalKey: "a",
                            playedAt: new Date("2026-09-01T10:01:00.000Z"),
                            listenedSeconds: null,
                            completionRatio: 0.5,
                            outcome: "skipped",
                        },
                    ],
                },
            ]),
        });

        const report = await service.evaluate({ since, until });

        expect(report.algorithms.baseline.engagement?.earlySkipRate).toBe(0);
    });

    it("reports playability, failures, meaningful completion and artist diversity", async () => {
        const service = new RecommendationShadowEvaluationService({
            loadGenerations: jest.fn().mockResolvedValue([
                {
                    id: "hybrid-active",
                    userId: "alice",
                    sessionId: "session-quality",
                    surface: "wave",
                    direction: "for-you",
                    mood: null,
                    cursor: 0,
                    algorithm: "hybrid-v2",
                    served: true,
                    createdAt: new Date("2026-09-01T10:00:00.000Z"),
                    exposures: [
                        {
                            canonicalKey: "meaningful",
                            artistKey: "artist-a",
                            exposedAt: new Date("2026-09-01T10:00:00.000Z"),
                            playedAt: new Date("2026-09-01T10:01:00.000Z"),
                            listenedSeconds: 45,
                            completionRatio: 0.4,
                            outcome: "meaningful",
                        },
                        {
                            canonicalKey: "failed",
                            artistKey: "artist-a",
                            exposedAt: new Date("2026-09-01T10:00:01.000Z"),
                            playedAt: new Date("2026-09-01T10:01:01.000Z"),
                            listenedSeconds: 0,
                            completionRatio: 0,
                            outcome: "failed",
                        },
                        {
                            canonicalKey: "skipped",
                            artistKey: "artist-b",
                            exposedAt: new Date("2026-09-01T10:00:02.000Z"),
                            playedAt: new Date("2026-09-01T10:01:02.000Z"),
                            listenedSeconds: 10,
                            completionRatio: 0.1,
                            outcome: "skipped",
                        },
                        {
                            canonicalKey: "completed",
                            artistKey: "",
                            exposedAt: new Date("2026-09-01T10:00:03.000Z"),
                            playedAt: new Date("2026-09-01T10:01:03.000Z"),
                            listenedSeconds: 180,
                            completionRatio: 1,
                            outcome: "completed",
                        },
                    ],
                },
            ]),
        });

        const report = await service.evaluate({ since, until });

        expect(report.algorithms.hybrid.playability).toEqual({
            attemptedCount: 4,
            playableCount: 3,
            failureCount: 1,
            playableHitRate: 0.75,
            failureRate: 0.25,
            meaningfulCompletionCount: 2,
            meaningfulCompletionRate: 0.5,
            earlySkipCount: 1,
            earlySkipRate: 0.25,
        });
        expect(report.algorithms.hybrid.artists).toEqual({
            coveredExposureCount: 3,
            uniqueArtistCount: 2,
            artistCoverageRate: 0.75,
            artistDiversityRate: 2 / 3,
        });
    });

    it("measures one-day and seven-day repeats against served history without counting shadow as history", async () => {
        const loadGenerations = jest.fn().mockResolvedValue([
            {
                id: "history-one-day",
                userId: "alice",
                sessionId: "history-one",
                surface: "home",
                direction: "for-you",
                mood: null,
                cursor: 0,
                algorithm: "baseline-v1",
                served: true,
                createdAt: new Date("2026-08-31T12:00:00.000Z"),
                exposures: [
                    {
                        canonicalKey: "repeat-one-day",
                        artistKey: "artist-a",
                        exposedAt: new Date("2026-08-31T12:00:00.000Z"),
                        playedAt: null,
                        listenedSeconds: null,
                        completionRatio: null,
                        outcome: null,
                    },
                ],
            },
            {
                id: "history-seven-day",
                userId: "alice",
                sessionId: "history-seven",
                surface: "home",
                direction: "for-you",
                mood: null,
                cursor: 0,
                algorithm: "baseline-v1",
                served: true,
                createdAt: new Date("2026-08-27T10:00:00.000Z"),
                exposures: [
                    {
                        canonicalKey: "repeat-seven-day",
                        artistKey: "artist-b",
                        exposedAt: new Date("2026-08-27T10:00:00.000Z"),
                        playedAt: null,
                        listenedSeconds: null,
                        completionRatio: null,
                        outcome: null,
                    },
                ],
            },
            {
                id: "hybrid-shadow",
                userId: "alice",
                sessionId: "current-shadow",
                surface: "wave",
                direction: "for-you",
                mood: null,
                cursor: 0,
                algorithm: "hybrid-v2",
                served: false,
                createdAt: new Date("2026-09-01T10:00:00.000Z"),
                exposures: ["repeat-one-day", "repeat-seven-day", "fresh"].map(
                    (canonicalKey, index) => ({
                        canonicalKey,
                        artistKey: `artist-${index}`,
                        exposedAt: new Date(`2026-09-01T10:00:0${index}.000Z`),
                        playedAt: null,
                        listenedSeconds: null,
                        completionRatio: null,
                        outcome: null,
                    }),
                ),
            },
        ]);
        const service = new RecommendationShadowEvaluationService({
            loadGenerations,
        });
        const repeatWindow = {
            since: new Date("2026-09-01T00:00:00.000Z"),
            until: new Date("2026-09-02T00:00:00.000Z"),
        };

        const report = await service.evaluate(repeatWindow);

        expect(loadGenerations).toHaveBeenCalledWith(
            new Date("2026-08-25T00:00:00.000Z"),
            repeatWindow.until,
        );
        expect(report.algorithms.hybrid.repeats).toEqual({
            exposureCount: 3,
            repeatOneDayCount: 1,
            repeatOneDayRate: 1 / 3,
            repeatSevenDayCount: 2,
            repeatSevenDayRate: 2 / 3,
        });
    });

    it("ignores only the paired baseline while retaining older history from the same session key", async () => {
        const shared = {
            userId: "alice",
            sessionId: "same-session",
            surface: "wave",
            direction: "for-you",
            mood: null,
            cursor: 0,
        };
        const exposure = (exposedAt: string) => ({
            canonicalKey: "repeat",
            artistKey: "artist",
            exposedAt: new Date(exposedAt),
            playedAt: null,
            listenedSeconds: null,
            completionRatio: null,
            outcome: null,
        });
        const service = new RecommendationShadowEvaluationService({
            loadGenerations: jest.fn().mockResolvedValue([
                {
                    id: "older-baseline",
                    ...shared,
                    algorithm: "baseline-v1",
                    served: true,
                    createdAt: new Date("2026-08-29T10:00:00.000Z"),
                    exposures: [exposure("2026-08-29T10:00:00.000Z")],
                },
                {
                    id: "paired-baseline",
                    ...shared,
                    algorithm: "baseline-v1",
                    served: true,
                    createdAt: new Date("2026-09-01T09:59:59.000Z"),
                    exposures: [exposure("2026-09-01T09:59:59.000Z")],
                },
                {
                    id: "hybrid-shadow",
                    ...shared,
                    algorithm: "hybrid-v2",
                    served: false,
                    createdAt: new Date("2026-09-01T10:00:00.000Z"),
                    exposures: [exposure("2026-09-01T10:00:00.000Z")],
                },
            ]),
        });

        const report = await service.evaluate({
            since: new Date("2026-09-01T09:00:00.000Z"),
            until: new Date("2026-09-01T11:00:00.000Z"),
        });

        expect(report.algorithms.hybrid.repeats).toEqual({
            exposureCount: 1,
            repeatOneDayCount: 0,
            repeatOneDayRate: 0,
            repeatSevenDayCount: 1,
            repeatSevenDayRate: 1,
        });
    });
});
