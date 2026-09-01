import {
    parseShadowEvaluationWindow,
    runShadowEvaluationCli,
} from "../evaluateRecommendationShadow";

describe("recommendation shadow evaluation CLI", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");

    it("parses a bounded rolling-hour window", () => {
        expect(parseShadowEvaluationWindow(["--hours", "24"], now)).toEqual({
            since: new Date("2026-08-31T12:00:00.000Z"),
            until: now,
        });
    });

    it("prints a read-only report for an explicit ISO window", async () => {
        const report = { pairedShadow: { pairCount: 2 } };
        const evaluate = jest.fn().mockResolvedValue(report);
        const write = jest.fn();

        await runShadowEvaluationCli(
            [
                "--since=2026-08-31T12:00:00.000Z",
                "--until=2026-09-01T12:00:00.000Z",
            ],
            { now: () => now, evaluate, write },
        );

        expect(evaluate).toHaveBeenCalledWith({
            since: new Date("2026-08-31T12:00:00.000Z"),
            until: new Date("2026-09-01T12:00:00.000Z"),
        });
        expect(write).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
    });

    it("rejects invalid or ambiguous windows before querying", async () => {
        expect(() => parseShadowEvaluationWindow(["--hours=0"], now)).toThrow(
            "hours",
        );
        await expect(
            runShadowEvaluationCli(
                [
                    "--hours=24",
                    "--since=2026-08-31T12:00:00.000Z",
                    "--until=2026-09-01T12:00:00.000Z",
                ],
                {
                    now: () => now,
                    evaluate: jest.fn(),
                    write: jest.fn(),
                },
            ),
        ).rejects.toThrow("either");
    });
});
