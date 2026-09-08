import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const mockBudget = { remoteAnalysisDailyBudget: 2 };
const mockRedisEval = jest.fn();
jest.mock("../../../config", () => ({
    config: { recommendations: mockBudget, features: {}, music: {} },
}));
jest.mock("../../../utils/redis", () => ({
    redisClient: { eval: mockRedisEval },
}));
jest.mock("../../../utils/db", () => ({ prisma: {} }));
import { claimRemoteAnalysisDailyBudget } from "../remoteAnalysisHotSet";

const container = process.env.REDIS_TEST_CONTAINER;
const run = promisify(execFile);
const suite = container ? describe : describe.skip;
suite("real Redis analysis admission", () => {
    let prefix: string;
    const now = new Date("2030-01-01T00:00:00Z");
    function redis(...args: string[]): string {
        if (!container?.startsWith("soundspan-wave-budget-test-"))
            throw Error("Dedicated test container required");
        return execFileSync(
            "docker",
            ["exec", container, "redis-cli", "--raw", ...args],
            { encoding: "utf8", timeout: 10_000 },
        ).trim();
    }
    beforeEach(() => {
        prefix = `test:${randomUUID()}:`;
        mockBudget.remoteAnalysisDailyBudget = 2;
        mockRedisEval.mockImplementation(
            async (
                script: string,
                input: { keys: string[]; arguments: string[] },
            ) => {
                if (!container?.startsWith("soundspan-wave-budget-test-"))
                    throw Error("Dedicated test container required");
                const result = await run(
                    "docker",
                    [
                        "exec",
                        container,
                        "redis-cli",
                        "--raw",
                        "EVAL",
                        script,
                        String(input.keys.length),
                        ...input.keys.map((key) => prefix + key),
                        ...input.arguments,
                    ],
                    { timeout: 10_000 },
                );
                return Number(result.stdout.trim());
            },
        );
    });
    const claim = (id: string) => claimRemoteAnalysisDailyBudget(id, now);
    const counter = () =>
        redis(
            "GET",
            prefix + "recommendation:remote-analysis:budget:2030-01-01",
        );

    it("does not count denied work as consumed budget", async () => {
        expect(await claim("one")).toBe(true);
        expect(await claim("two")).toBe(true);
        expect(await claim("three")).toBe(false);
        expect(await claim("four")).toBe(false);
        expect(counter()).toBe("2");
    });
    it("reconsiders a denied recording after an approved limit increase", async () => {
        await claim("one");
        await claim("two");
        expect(await claim("three")).toBe(false);
        mockBudget.remoteAnalysisDailyBudget = 3;
        expect(await claim("three")).toBe(true);
        expect(counter()).toBe("3");
    });
    it("charges repeated allowed claims only once", async () => {
        const results = await Promise.all(
            Array.from({ length: 8 }, () => claim("same")),
        );
        expect(results.every(Boolean)).toBe(true);
        expect(counter()).toBe("1");
    });
    it("keeps the admission ceiling under competing claims", async () => {
        const results = await Promise.all(
            Array.from({ length: 8 }, (_, i) => claim(String(i))),
        );
        expect(results.filter(Boolean)).toHaveLength(2);
        expect(counter()).toBe("2");
    });
});
