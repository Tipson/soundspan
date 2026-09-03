jest.mock("../../../utils/db", () => ({ prisma: { $transaction: jest.fn() } }));
jest.mock("../../../utils/redis", () => ({
    redisClient: {
        isReady: true,
        withCommandOptions: jest.fn(),
        get: jest.fn(),
    },
}));
jest.mock("../../../config", () => ({
    config: {
        features: { audioAnalysis: true },
        recommendations: {
            remoteAnalysisEnabled: true,
            remoteAnalysisDailyBudget: 250,
            remoteAnalysisConcurrency: 2,
        },
    },
}));

import { prisma } from "../../../utils/db";
import { redisClient } from "../../../utils/redis";
import {
    getOnlineAnalysisProgress,
    loadOnlineAnalysisProgress,
} from "../onlineAnalysisProgress";

const now = new Date("2026-09-03T22:00:00Z");
const count = jest.fn();
const aggregate = jest.fn();
const space = jest.fn();
const tx = {
    canonicalRecording: { count, aggregate },
    embeddingSpace: { findFirst: space },
};

beforeEach(() => {
    jest.resetAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation((load) => load(tx));
    (redisClient.withCommandOptions as jest.Mock).mockReturnValue(redisClient);
    (redisClient.get as jest.Mock).mockResolvedValue("258");
    space.mockResolvedValue({ id: "active-space", family: "dclap" });
    // total, audio completed / failed / last 24h, vector completed / failed / last 24h, active assets
    [100, 30, 2, 5, 40, 3, 7, 1].forEach((n) => count.mockResolvedValueOnce(n));
    aggregate.mockResolvedValue({
        _max: { analyzedAt: now, embeddingAnalyzedAt: now },
    });
});

test("reports shared canonical coverage, independent stages, real active vectors and quota checks", async () => {
    const result = await loadOnlineAnalysisProgress(now);
    expect(result).toMatchObject({
        total: 100,
        activeAssets: 1,
        audio: { completed: 30, failed: 2, remaining: 70, completedLast24h: 5 },
        embeddings: {
            completed: 40,
            failed: 3,
            remaining: 60,
            completedLast24h: 7,
        },
        budget: {
            dailyLimit: 250,
            checkedToday: 258,
            concurrency: 2,
            resetsAt: "2026-09-04T00:00:00.000Z",
        },
    });
    expect(count).toHaveBeenCalledWith({
        where: { embeddings: { some: { spaceId: "active-space" } } },
    });
    expect(count).toHaveBeenCalledWith({
        where: {
            embeddingStatus: "failed",
            embeddings: { none: { spaceId: "active-space" } },
        },
    });
    expect(space).toHaveBeenCalledWith(
        expect.objectContaining({
            where: { status: "active", cleaningAt: null },
        }),
    );
    expect(redisClient.get).toHaveBeenCalledWith(
        "recommendation:remote-analysis:budget:2026-09-03",
    );
});

test("Redis failure does not turn a real database snapshot into zero counts", async () => {
    (redisClient.get as jest.Mock).mockRejectedValue(new Error("offline"));
    const result = await loadOnlineAnalysisProgress(now);
    expect(result.audio.completed).toBe(30);
    expect(result.budget.checkedToday).toBeNull();
});

test("missing active space is unavailable coverage, not completed retired vectors", async () => {
    space.mockResolvedValue(null);
    const result = await loadOnlineAnalysisProgress(now);
    expect(result.activeSpace).toBeNull();
    expect(result.embeddings).toBeNull();
});

test.each(["invalid", "-1", "1.5"])(
    "invalid quota value %s stays unknown",
    async (value) => {
        (redisClient.get as jest.Mock).mockResolvedValue(value);
        expect(
            (await loadOnlineAnalysisProgress(now)).budget.checkedToday,
        ).toBeNull();
    },
);

test("database failure rejects instead of returning a successful empty catalog", async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValue(
        new Error("database unavailable"),
    );
    await expect(loadOnlineAnalysisProgress(now)).rejects.toThrow(
        "database unavailable",
    );
});

test("dashboard polls share one database snapshot instead of duplicating work", async () => {
    const [first, second] = await Promise.all([
        getOnlineAnalysisProgress(),
        getOnlineAnalysisProgress(),
    ]);
    expect(first).toEqual(second);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
});
