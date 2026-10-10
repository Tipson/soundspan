import type { Request, Response } from "express";

const discoverQueue = {
    client: { options: { db: 0 } },
    getWorkers: jest.fn(),
    isPaused: jest.fn(),
    getJob: jest.fn(),
    add: jest.fn(),
};
jest.mock("../../workers/queues", () => ({ discoverQueue }));
jest.mock("../../utils/logger", () => ({
    logger: {
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn().mockReturnThis(),
    },
}));

import {
    handleGenerateStatus,
    handleModernGenerate,
} from "../discover/generation";

const req = { user: { id: "owner" } } as Request;
function response() {
    const res = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(body: unknown) {
            this.body = body;
            return this;
        },
    };
    return res;
}

beforeEach(() => {
    jest.resetAllMocks();
    discoverQueue.client.options.db = 0;
    discoverQueue.getWorkers.mockResolvedValue([
        { name: "discover-weekly", db: "0" },
    ]);
    discoverQueue.isPaused.mockResolvedValue(false);
    discoverQueue.getJob.mockResolvedValue(null);
    discoverQueue.add.mockResolvedValue({ id: "discover:manual:owner" });
});
afterEach(() => jest.useRealTimers());

async function generate() {
    const res = response();
    await handleModernGenerate(req, res as unknown as Response);
    return res;
}

it.each([[], undefined])(
    "rejects generation without a discover consumer (%j)",
    async (workers) => {
        discoverQueue.getWorkers.mockResolvedValue(workers);
        const res = await generate();
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({
            error: "Local discovery generation is unavailable",
        });
        expect(discoverQueue.getJob).not.toHaveBeenCalled();
        expect(discoverQueue.add).not.toHaveBeenCalled();
    },
);

it("does not advertise a queued job as progressing when its consumer is absent", async () => {
    discoverQueue.getWorkers.mockResolvedValue([]);
    const stale = {
        getState: jest.fn().mockResolvedValue("waiting"),
        remove: jest.fn(),
    };
    discoverQueue.getJob.mockResolvedValue(stale);
    const res = await generate();
    expect(res.statusCode).toBe(503);
    expect(discoverQueue.add).not.toHaveBeenCalled();
    expect(stale.remove).not.toHaveBeenCalled();
});

it("rejects generation while the queue is globally paused", async () => {
    discoverQueue.isPaused.mockResolvedValue(true);
    const res = await generate();
    expect(res.statusCode).toBe(503);
    expect(discoverQueue.add).not.toHaveBeenCalled();
});

it("does not admit work using a consumer from another Redis database", async () => {
    discoverQueue.getWorkers.mockResolvedValue([
        { name: "discover-weekly", db: "1" },
    ]);
    const res = await generate();
    expect(res.statusCode).toBe(503);
    expect(discoverQueue.add).not.toHaveBeenCalled();
});

it("admits work in the queue's configured Redis database", async () => {
    discoverQueue.client.options.db = 2;
    discoverQueue.getWorkers.mockResolvedValue([
        { name: "discover-weekly", db: "2" },
    ]);
    const res = await generate();
    expect(res.statusCode).toBe(200);
});

it.each(["getWorkers", "isPaused"] as const)(
    "fails closed when %s is unavailable without exposing Redis details",
    async (operation) => {
        discoverQueue[operation].mockRejectedValue(
            new Error("redis://password@private-host"),
        );
        const res = await generate();
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({
            error: "Local discovery generation is unavailable",
        });
        expect(discoverQueue.add).not.toHaveBeenCalled();
    },
);

it("bounds admission and ignores a late readiness response", async () => {
    jest.useFakeTimers();
    let resolveWorkers!: (workers: { name: string }[]) => void;
    discoverQueue.getWorkers.mockReturnValue(
        new Promise((resolve) => {
            resolveWorkers = resolve;
        }),
    );
    const pending = generate();
    await jest.advanceTimersByTimeAsync(2_001);
    const res = await pending;
    expect(res.statusCode).toBe(503);
    resolveWorkers([{ name: "discover-weekly" }]);
    await Promise.resolve();
    expect(discoverQueue.add).not.toHaveBeenCalled();
});

it("retains manual local generation when an unpaused consumer is available", async () => {
    const res = await generate();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
        message: "Discover Weekly recommendation generation started",
        jobId: "discover:manual:owner",
    });
    expect(discoverQueue.add).toHaveBeenCalledWith(
        "discover-recommendation",
        { userId: "owner" },
        { jobId: "discover:manual:owner" },
    );
});

it("keeps the existing conflict for a running job with an available consumer", async () => {
    discoverQueue.getJob.mockResolvedValue({
        id: "discover:manual:owner",
        getState: async () => "active",
    });
    const res = await generate();
    expect(res.statusCode).toBe(409);
    expect(discoverQueue.add).not.toHaveBeenCalled();
});

it("does not report a new generation when stale job removal fails", async () => {
    discoverQueue.getJob.mockResolvedValue({
        getState: async () => "completed",
        remove: async () => {
            throw new Error("private remove failure");
        },
    });
    const res = await generate();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Failed to start generation" });
    expect(discoverQueue.add).not.toHaveBeenCalled();
});

it.each([{ userId: "other-owner" }, undefined, { userId: 42 }, {}])(
    "hides an inaccessible job status (%j)",
    async (data) => {
        const job = {
            data,
            getState: jest.fn(async () => "completed"),
            progress: jest.fn(() => 100),
            returnvalue: { playlistId: "private-result" },
        };
        discoverQueue.getJob.mockResolvedValue(job);
        const res = response();
        await handleGenerateStatus(
            { ...req, params: { jobId: "foreign-job" } } as unknown as Request<{
                jobId: string;
            }>,
            res as unknown as Response,
        );
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Job not found" });
        expect(job.getState).not.toHaveBeenCalled();
        expect(job.progress).not.toHaveBeenCalled();
    },
);

it("returns a generation result to its authenticated owner", async () => {
    discoverQueue.getJob.mockResolvedValue({
        data: { userId: "owner" },
        getState: async () => "completed",
        progress: () => 100,
        returnvalue: { playlistId: "owned-result" },
    });
    const res = response();
    await handleGenerateStatus(
        { ...req, params: { jobId: "owned-job" } } as unknown as Request<{
            jobId: string;
        }>,
        res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
        status: "completed",
        progress: 100,
        result: { playlistId: "owned-result" },
    });
});
