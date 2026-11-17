import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { FrozenRecommendationReplayReportV1 } from "../frozenReplay";

jest.mock("../../../utils/db", () => {
    throw new Error("Frozen replay must not load production DB dependencies");
});
jest.mock("../../../metrics", () => {
    throw new Error(
        "Frozen replay must not load the production metrics registry",
    );
});

function moduleUnderTest(): typeof import("../frozenReplay") {
    return require("../frozenReplay");
}

function fixture(): any {
    return JSON.parse(
        readFileSync(
            resolve(
                __dirname,
                "../../../../../fixtures/recommendation-replay-v1.json",
            ),
            "utf8",
        ),
    );
}

function identities(report: FrozenRecommendationReplayReportV1) {
    return report.runs.map((run) => ({
        id: run.id,
        mode: run.mode,
        rolloutPercent: run.rolloutPercent,
        served: {
            ...run.served,
            items: run.served.items.map(({ scoreTrace, ...item }) => item),
            trace: undefined,
        },
        shadow: run.shadow
            ? {
                  ...run.shadow,
                  items: run.shadow.items.map(
                      ({ scoreTrace, ...item }) => item,
                  ),
                  trace: undefined,
              }
            : null,
        evaluation: run.evaluation,
    }));
}

describe("frozen recommendation replay", () => {
    afterEach(() => jest.restoreAllMocks());

    it("runs a bounded UTF-8 file through the CLI and rejects oversize before parsing", async () => {
        const { runRecommendationReplayCli } =
            require("../../../scripts/recommendationReplay") as typeof import("../../../scripts/recommendationReplay");
        const write = jest.fn();
        await runRecommendationReplayCli(
            [
                "--input",
                resolve(
                    __dirname,
                    "../../../../../fixtures/recommendation-replay-v1.json",
                ),
            ],
            write,
        );
        expect(JSON.parse(write.mock.calls[0][0]).version).toBe(1);
        const file = {
            stat: jest.fn().mockResolvedValue({
                isFile: () => true,
                size: 2 * 1024 * 1024 + 1,
            }),
            close: jest.fn().mockResolvedValue(undefined),
        };
        jest.spyOn(
            require("node:fs/promises") as typeof import("node:fs/promises"),
            "open",
        ).mockResolvedValue(file as unknown as FileHandle);
        const parse = jest.spyOn(JSON, "parse");
        await expect(
            runRecommendationReplayCli(
                ["--input", "oversized-synthetic-fixture.json"],
                write,
            ),
        ).rejects.toThrow(/byte limit/);
        expect(parse).not.toHaveBeenCalled();
        expect(file.close).toHaveBeenCalledTimes(1);
    });

    it("keeps the existing DI evaluator independent from production persistence imports", async () => {
        const { RecommendationShadowEvaluationService } =
            require("../shadowEvaluation") as typeof import("../shadowEvaluation");
        const service = new RecommendationShadowEvaluationService({
            loadGenerations: async () => [],
        });
        expect(
            (
                await service.evaluate({
                    since: new Date("2026-11-15T12:00:00.000Z"),
                    until: new Date("2026-11-15T12:00:00.001Z"),
                })
            ).algorithms.baseline.generationCount,
        ).toBe(0);
    });

    it("replays actual engine modes deterministically without mutating frozen inputs", async () => {
        const {
            runFrozenRecommendationReplay,
            validateFrozenRecommendationReplay,
        } = moduleUnderTest();
        const input = fixture();
        const before = structuredClone(input);
        expect(validateFrozenRecommendationReplay(input)).toEqual(input);
        const first = await runFrozenRecommendationReplay(input, {
            traceEnabled: true,
        });
        const second = await runFrozenRecommendationReplay(input, {
            traceEnabled: true,
        });
        expect(second).toEqual(first);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        expect(input).toEqual(before);
        expect(first.version).toBe(1);
        expect(first.sessionId).toBe(input.request.sessionId);
        expect(first.runs.map(({ id }) => id)).toEqual([
            "baseline",
            "shadow",
            "active-0",
            "active-50",
            "active-100",
        ]);
        expect(first.runs.map(({ served }) => served.algorithm)).toEqual([
            "baseline-v1",
            "baseline-v1",
            "baseline-v1",
            "hybrid-v2",
            "hybrid-v2",
        ]);
        expect(
            first.runs[0].served.items.map(({ candidateId }) => candidateId),
        ).toEqual(["a1", "b", "c", "a2", "d", "e"]);
        for (const run of first.runs) {
            expect(run.served.items.map(({ position }) => position)).toEqual(
                run.served.items.map((_, index) => index),
            );
            expect(run.served.id).toBe(`replay:${run.id}:served`);
            expect(run.served.trace).toBeDefined();
            expect(run.evaluation.dataQuality).toBeNull();
            if (run.mode === "active")
                expect(run.served.assignment).toBe("session-switchback-v1");
        }
    });

    it("retains exact served and shadow identities, scores and evaluator output with diagnostics off/on", async () => {
        const { runFrozenRecommendationReplay } = moduleUnderTest();
        const off = await runFrozenRecommendationReplay(fixture());
        const on = await runFrozenRecommendationReplay(fixture(), {
            traceEnabled: true,
        });
        expect(identities(on)).toEqual(identities(off));
        expect(
            off.runs.every(
                ({ served, shadow }) =>
                    !served.trace &&
                    !shadow?.trace &&
                    served.items.every((item) => !("scoreTrace" in item)),
            ),
        ).toBe(true);
        const otherSession = fixture();
        otherSession.request.sessionId = "replay-session-b";
        const switched = await runFrozenRecommendationReplay(otherSession);
        expect(
            switched.runs.find(({ id }) => id === "active-50")?.served
                .algorithm,
        ).toBe("baseline-v1");
        expect(
            switched.runs.find(({ id }) => id === "active-0")?.served.algorithm,
        ).toBe("baseline-v1");
        expect(
            switched.runs.find(({ id }) => id === "active-100")?.served
                .algorithm,
        ).toBe("hybrid-v2");
    });

    it("keeps blocked aliases, recent tracks and unavailable recordings out during scarcity", async () => {
        const input = fixture();
        input.candidates = input.candidates.filter(
            (row: { id: string }) => !["b", "c", "d", "e"].includes(row.id),
        );
        input.request.limit = 12;
        const report = await moduleUnderTest().runFrozenRecommendationReplay(
            input,
            { traceEnabled: true },
        );
        for (const run of report.runs) {
            expect(
                run.served.items.map(({ candidateId }) => candidateId).sort(),
            ).toEqual(["a1", "a2", "unknown"]);
            for (const generation of [run.served, run.shadow].filter(Boolean)) {
                expect(
                    generation!.items.every(
                        ({ candidateId }) =>
                            ![
                                "blocked",
                                "blocked-alias",
                                "recent",
                                "unavailable",
                            ].includes(candidateId),
                    ),
                ).toBe(true);
            }
        }
    });

    it("preserves the engine safe fallback when optional feature enrichment fails", async () => {
        const input = fixture();
        input.config.featureFailure = true;
        input.config.tasteFailure = true;
        const report = await moduleUnderTest().runFrozenRecommendationReplay(
            input,
            { traceEnabled: true },
        );
        for (const run of report.runs) {
            expect(run.served.degradedSources).toEqual(
                expect.arrayContaining(["canonical-features", "taste-profile"]),
            );
            expect(run.served.items.length).toBeGreaterThan(0);
            expect(
                run.served.items.some(({ candidateId }) =>
                    [
                        "blocked",
                        "blocked-alias",
                        "recent",
                        "unavailable",
                    ].includes(candidateId),
                ),
            ).toBe(false);
        }
    });

    it("keeps exposure, viewing and listening distinct and scopes existing evaluator results per run", async () => {
        const { runFrozenRecommendationReplay } = moduleUnderTest();
        const report = await runFrozenRecommendationReplay(fixture());
        for (const run of report.runs) {
            expect(run.evaluation.algorithms.baseline.engagement).toBeNull();
            expect(run.evaluation.algorithms.hybrid.engagement).toBeNull();
            expect(run.evaluation.algorithms.baseline.playability).toBeNull();
            expect(run.evaluation.algorithms.hybrid.playability).toBeNull();
            expect(
                run.evaluation.withinAccountSwitchback.comparableAccountCount,
            ).toBe(0);
        }
        const input = fixture();
        input.observations = [
            {
                runId: "shadow",
                candidateId: "a1",
                viewed: true,
                outcome: "completed",
                listenedSeconds: 180,
                completionRatio: 1,
            },
        ];
        const observed = await runFrozenRecommendationReplay(input);
        const shadow = observed.runs.find(({ id }) => id === "shadow")!;
        expect(
            shadow.evaluation.algorithms.baseline.engagement?.attributedCount,
        ).toBe(1);
        expect(
            shadow.evaluation.algorithms.baseline.playability?.attemptedCount,
        ).toBe(1);
        expect(shadow.evaluation.algorithms.hybrid.engagement).toBeNull();
        expect(shadow.evaluation.algorithms.hybrid.playability).toBeNull();
        expect(shadow.evaluation.pairedShadow.pairCount).toBe(1);
        expect(
            observed.runs.find(({ id }) => id === "active-100")!.evaluation
                .algorithms.hybrid.engagement,
        ).toBeNull();
    });

    it.each([
        [
            "unknown version",
            (input: any) => {
                input.version = 2;
            },
        ],
        [
            "inconsistent dimensions",
            (input: any) => {
                input.candidates[0].embedding = [1, 0, 0];
            },
        ],
        [
            "oversized vector",
            (input: any) => {
                input.candidates[0].embedding = Array(2049).fill(0);
            },
        ],
        [
            "oversized pool",
            (input: any) => {
                input.candidates = Array.from({ length: 257 }, (_, index) => ({
                    ...input.candidates[0],
                    id: `row-${index}`,
                }));
            },
        ],
        [
            "too many centroids",
            (input: any) => {
                input.taste.positiveCentroids = Array(6).fill([1, 0]);
            },
        ],
        [
            "nonfinite coordinate",
            (input: any) => {
                input.candidates[0].embedding[0] = Infinity;
            },
        ],
        [
            "media URL",
            (input: any) => {
                input.candidates[0].artist =
                    "https://private.example/audio?token=secret";
            },
        ],
        [
            "provider canonical assertion",
            (input: any) => {
                input.candidates[0].canonicalRecordingId = "real-canonical-id";
            },
        ],
        [
            "unknown signal target",
            (input: any) => {
                input.signals.dislikedCandidateIds = ["not-in-pool"];
            },
        ],
        [
            "unviewed playback observation",
            (input: any) => {
                input.observations = [
                    {
                        runId: "shadow",
                        candidateId: "a1",
                        viewed: false,
                        outcome: "completed",
                    },
                ];
            },
        ],
    ])(
        "rejects %s before constructing an engine or writing any generation",
        async (_name, change) => {
            const input = fixture();
            change(input);
            const engine = require("../engine") as typeof import("../engine");
            const constructor = jest
                .spyOn(engine, "RecommendationEngine")
                .mockImplementation(() => {
                    throw new Error("Must validate before construction");
                });
            await expect(
                moduleUnderTest().runFrozenRecommendationReplay(input),
            ).rejects.toThrow(/Frozen recommendation replay/);
            expect(constructor).not.toHaveBeenCalled();
        },
    );
});
