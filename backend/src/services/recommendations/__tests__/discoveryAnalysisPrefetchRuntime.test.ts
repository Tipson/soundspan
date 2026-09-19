const mockRedis = { get: jest.fn(), set: jest.fn(), eval: jest.fn() };
const mockQueue = {
    getJobCounts: jest.fn(),
    getJob: jest.fn(),
    add: jest.fn(),
};
const mockPrisma = {
    play: { groupBy: jest.fn() },
    user: { findUnique: jest.fn() },
};
const mockFeed = jest.fn();
jest.mock("../../../config", () => ({
    config: {
        features: { audioAnalysis: true },
        recommendations: {
            remoteAnalysisEnabled: true,
            remoteAnalysisDailyBudget: 750,
        },
    },
}));
jest.mock("../../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../../utils/redis", () => ({ redisClient: mockRedis }));
jest.mock("../../../utils/logger", () => ({
    logger: { child: () => ({ info: jest.fn(), warn: jest.fn() }) },
}));
jest.mock("../../../workers/queues", () => ({
    remoteAnalysisQueue: mockQueue,
}));
jest.mock("../canonicalIdentity", () => ({
    canonicalIdentityResolver: {
        resolve: jest.fn(async (candidate) => ({
            id: candidate.id,
            canonicalKey: `canonical:${candidate.id}`,
        })),
    },
}));
jest.mock("../recommendationRuntime", () => ({
    unifiedRecommendationService: { getPersonalizedFeed: mockFeed },
}));
// Isolate adapter orchestration; canonical admission and leases have separate real scheduler tests.
jest.mock("../remoteAnalysisHotSet", () => ({
    loadRemoteAnalysisCoveredCanonicalIds: jest.fn(async () => new Set()),
    RemoteAnalysisHotSetScheduler: class {
        constructor(
            private dependencies: {
                isAccountEligible(userId: string): Promise<boolean>;
                enqueue(job: unknown, id: string): Promise<void>;
            },
        ) {}
        async schedule(input: {
            userId: string;
            candidates: Array<{ id: string }>;
        }) {
            if (!(await this.dependencies.isAccountEligible(input.userId)))
                return;
            for (const candidate of input.candidates)
                await this.dependencies.enqueue(
                    {
                        userId: input.userId,
                        canonicalRecordingId: candidate.id,
                    },
                    `remote-analysis:${candidate.id}`,
                );
        }
    },
}));
import {
    startDiscoveryAnalysisPrefetch,
    stopDiscoveryAnalysisPrefetch,
} from "../discoveryAnalysisPrefetchRuntime";

let stored: Map<string, string>;
beforeEach(() => {
    jest.clearAllMocks();
    stored = new Map();
    mockRedis.get.mockImplementation(async (key) => stored.get(key) ?? null);
    mockRedis.set.mockImplementation(async (key, value, options) => {
        if (options?.NX && stored.has(key)) return null;
        stored.set(key, value);
        return "OK";
    });
    mockRedis.eval.mockImplementation(
        async (_script, { keys, arguments: args }) => {
            if (stored.get(keys[0]) !== args[0]) return 0;
            if (keys.length === 1) stored.delete(keys[0]);
            else stored.set(keys[1], args[1]);
            return 1;
        },
    );
    mockPrisma.play.groupBy.mockResolvedValue([{ userId: "listener" }]);
    mockPrisma.user.findUnique.mockResolvedValue({ isTestAccount: false });
    mockQueue.getJobCounts.mockResolvedValue({
        active: 0,
        waiting: 0,
        delayed: 0,
    });
    mockQueue.getJob.mockResolvedValue(null);
    mockQueue.add.mockResolvedValue(undefined);
    mockFeed.mockResolvedValue({
        shelves: {
            discovery: [
                {
                    id: "discovery",
                    provider: { youtubeVideoId: "video", tidalTrackId: null },
                },
            ],
            quickPicks: [{ id: "saved" }],
            listenAgain: [],
        },
        nextCursor: 2,
    });
});
afterEach(async () => {
    await stopDiscoveryAnalysisPrefetch();
    jest.restoreAllMocks();
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

it("uses the diagnostic engine, only discovery lane, ordinary stable job IDs and low priority", async () => {
    startDiscoveryAnalysisPrefetch();
    await settle();
    expect(mockFeed).toHaveBeenCalledWith(
        expect.objectContaining({
            diagnostic: true,
            surface: "wave",
            direction: "new",
            limit: 12,
            cursor: 0,
        }),
    );
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockQueue.add).toHaveBeenCalledWith(
        "analyze",
        expect.objectContaining({ canonicalRecordingId: "discovery" }),
        { jobId: "remote-analysis:discovery", priority: 10 },
    );
    expect(
        stored.get("recommendation:discovery-prefetch:cursor:listener"),
    ).toBe("2");
});

it.each(["budget", "backlog", "lock"])(
    "does no provider work under %s pressure",
    async (reason) => {
        if (reason === "budget")
            stored.set(
                `recommendation:remote-analysis:budget:${new Date().toISOString().slice(0, 10)}`,
                "375",
            );
        if (reason === "backlog")
            mockQueue.getJobCounts.mockResolvedValue({
                waiting: 12,
                active: 0,
                delayed: 0,
            });
        if (reason === "lock")
            stored.set(
                "recommendation:discovery-prefetch:lock",
                "another-worker",
            );
        startDiscoveryAnalysisPrefetch();
        await settle();
        expect(mockFeed).not.toHaveBeenCalled();
        expect(mockQueue.add).not.toHaveBeenCalled();
    },
);

it("does not enqueue when shutdown happens during an upstream request", async () => {
    let release!: (value: unknown) => void;
    mockFeed.mockReturnValue(
        new Promise((resolve) => {
            release = resolve;
        }),
    );
    startDiscoveryAnalysisPrefetch();
    await settle();
    const stopped = stopDiscoveryAnalysisPrefetch();
    release({ shelves: { discovery: [{ id: "late" }] }, nextCursor: 1 });
    await stopped;
    expect(mockQueue.add).not.toHaveBeenCalled();
});

it("rechecks cancellation after a delayed Redis lease response at the final enqueue boundary", async () => {
    let reads = 0;
    let release!: (value: string) => void;
    mockRedis.get.mockImplementation(async (key) => {
        if (key.endsWith(":lock") && ++reads === 4)
            return new Promise((resolve) => {
                release = resolve;
            });
        return stored.get(key) ?? null;
    });
    startDiscoveryAnalysisPrefetch();
    await settle();
    expect(release).toBeDefined();
    const stopped = stopDiscoveryAnalysisPrefetch();
    release(stored.get("recommendation:discovery-prefetch:lock")!);
    await stopped;
    expect(mockQueue.add).not.toHaveBeenCalled();
});

it("visits later accounts over three cycles after failures, including accounts past the first hundred", async () => {
    const users = Array.from(
        { length: 108 },
        (_, i) => `user-${String(i).padStart(3, "0")}`,
    );
    stored.set("recommendation:discovery-prefetch:last-user", "user-099");
    mockPrisma.play.groupBy.mockImplementation(async ({ where, take }) =>
        users
            .filter(
                (id) =>
                    (!where.userId?.gt || id > where.userId.gt) &&
                    (!where.userId?.lte || id <= where.userId.lte),
            )
            .slice(0, take)
            .map((userId) => ({ userId })),
    );
    mockFeed.mockRejectedValue(new Error("provider unavailable"));
    for (let cycle = 0; cycle < 3; cycle++) {
        startDiscoveryAnalysisPrefetch();
        await settle();
        await stopDiscoveryAnalysisPrefetch();
    }
    expect(mockFeed.mock.calls.map(([input]) => input.userId)).toEqual([
        ...users.slice(100),
        ...users.slice(0, 4),
    ]);
    expect(stored.get("recommendation:discovery-prefetch:last-user")).toBe(
        "user-003",
    );
    expect(
        [...stored.keys()].filter((key) => key.includes(":cursor:")),
    ).toEqual([]);
    expect(mockQueue.add).not.toHaveBeenCalled();
});

it("fills the final short page from the start without visiting anyone twice", async () => {
    stored.set("recommendation:discovery-prefetch:last-user", "b");
    mockPrisma.play.groupBy.mockImplementation(async ({ where, take }) =>
        ["a", "b", "c"]
            .filter(
                (id) =>
                    (!where.userId?.gt || id > where.userId.gt) &&
                    (!where.userId?.lte || id <= where.userId.lte),
            )
            .slice(0, take)
            .map((userId) => ({ userId })),
    );
    startDiscoveryAnalysisPrefetch();
    await settle();
    expect(mockFeed.mock.calls.map(([input]) => input.userId)).toEqual([
        "c",
        "a",
        "b",
    ]);
    expect(
        mockPrisma.play.groupBy.mock.calls.map(([input]) => input.take),
    ).toEqual([4, 3]);
});

it("cannot overwrite a successor's rotation cursor when the lease changes before the atomic write", async () => {
    const evaluate = mockRedis.eval.getMockImplementation()!;
    mockRedis.eval.mockImplementation(async (script, options) => {
        if (options.keys.length === 2) {
            stored.set(options.keys[0], "successor");
            stored.set(options.keys[1], "successor-account");
        }
        return evaluate(script, options);
    });
    startDiscoveryAnalysisPrefetch();
    await settle();
    expect(mockFeed).not.toHaveBeenCalled();
    expect(stored.get("recommendation:discovery-prefetch:last-user")).toBe(
        "successor-account",
    );
    expect(stored.get("recommendation:discovery-prefetch:lock")).toBe(
        "successor",
    );
});
