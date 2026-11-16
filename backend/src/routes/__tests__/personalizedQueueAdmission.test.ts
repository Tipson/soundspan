import { EventEmitter } from "node:events";
import express, {
    type NextFunction,
    type Request,
    type RequestHandler,
    type Response,
} from "express";
import request from "supertest";

const mockReadmit = jest.fn();
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken(req: Request, res: Response, next: NextFunction) {
        const owner = req.header("x-test-owner");
        if (!owner) return res.status(401).json({ error: "Not authenticated" });
        req.user = { id: owner, username: "tester", role: "user" };
        next();
    },
}));
jest.mock("../../services/recommendations/recommendationRuntime", () => ({
    unifiedRecommendationService: {},
}));
jest.mock("../../services/personalDailyMixes", () => ({
    personalDailyMixService: {},
}));
jest.mock("../../services/recommendations/exposureStore", () => ({
    recommendationExposureStore: {},
}));
jest.mock(
    "../../services/recommendations/finiteQueueAdmission",
    () => ({
        readmitRecommendationQueue: (...args: unknown[]) =>
            mockReadmit(...args),
    }),
);
jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});

import router from "../personalized";
import { RADIO_REQUEST_TIMEOUT_MS } from "../../services/recommendations/radioRequestExecution";

const path = "/api/personalized/queue-admission";
const reference = {
    source: "youtube",
    id: "abcdefghijk",
    generationId: "generation-1",
};
const response = {
    version: 1,
    appliesTo: "recommended_future",
    decisions: [{ source: "youtube", id: "abcdefghijk", state: "allowed" }],
};
const app = express();
app.use(express.json());
app.use("/api/personalized", router);
app.use(
    (_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ error: "Internal server error" });
    },
);

function harness() {
    const req = Object.assign(new EventEmitter(), {
        body: { references: [reference] },
        headers: {},
        user: { id: "alice" },
        aborted: false,
    }) as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
        writableEnded: false,
        destroyed: false,
        statusCode: 200,
    }) as unknown as Response;
    res.setHeader = jest.fn(() => res);
    res.status = jest.fn((code: number) => {
        res.statusCode = code;
        return res;
    });
    res.json = jest.fn(() => {
        Object.defineProperty(res, "writableEnded", {
            value: true,
            writable: true,
        });
        return res;
    });
    const handler: RequestHandler | undefined = router.stack.find(
        (layer) => layer.route?.path === "/queue-admission",
    )?.route?.stack[0].handle;
    expect(handler).toBeDefined();
    return { req, res, handler: handler!, next: jest.fn() };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockReadmit.mockResolvedValue(response);
});
afterEach(() => jest.useRealTimers());

test("queue admission requires authentication before reading any feedback", async () => {
    const result = await request(app)
        .post(path)
        .send({ references: [reference] });
    expect(result.status).toBe(401);
    expect(mockReadmit).not.toHaveBeenCalled();
});

test("uses the authenticated owner and preserves finite order, duplicate references and generation context", async () => {
    const references = [reference, { source: "vk", id: "-12_34" }, reference];
    const result = await request(app)
        .post(path)
        .set("x-test-owner", "alice")
        .send({ references });
    expect(result.status).toBe(200);
    expect(result.body).toEqual(response);
    expect(result.header["cache-control"]).toBe("no-store");
    expect(mockReadmit).toHaveBeenCalledTimes(1);
    expect(mockReadmit).toHaveBeenCalledWith(
        "alice",
        references,
        expect.any(Function),
    );
});

test.each([
    {},
    { references: [] },
    { references: new Array(101).fill(reference) },
    { references: [reference], userId: "bob" },
    { references: [{ ...reference, canonicalKey: "forged" }] },
    { references: [{ ...reference, artist: "Forged artist" }] },
    { references: [{ source: "youtube", id: "short" }] },
    {
        references: [
            { source: "youtube", id: "abcdefghijk", generationId: "" },
        ],
    },
    { references: [{ source: "library", id: "../secret" }] },
    { references: [{ source: "vk", id: "https://example.com" }] },
    { references: [{ source: "yandex", id: "0" }] },
    { references: [{ source: "tidal", id: "9007199254740992" }] },
    { references: [{ source: "other", id: "abc" }] },
])(
    "rejects invalid or metadata-authoritative bodies without service work: %j",
    async (body) => {
        const result = await request(app)
            .post(path)
            .set("x-test-owner", "alice")
            .send(body);
        expect(result.status).toBe(400);
        expect(result.body).toEqual({
            error: "Invalid recommendation queue references",
            code: "INVALID_QUEUE_ADMISSION",
        });
        expect(mockReadmit).not.toHaveBeenCalled();
    },
);

test("allows the full bounded batch without truncating repeated identities", async () => {
    const references = new Array(100).fill(reference);
    const result = await request(app)
        .post(path)
        .set("x-test-owner", "bob")
        .send({ references });
    expect(result.status).toBe(200);
    expect(mockReadmit.mock.calls[0][0]).toBe("bob");
    expect(mockReadmit.mock.calls[0][1]).toHaveLength(100);
});

test("disposes request listeners and deadline after ordinary completion", async () => {
    jest.useFakeTimers();
    const { req, res, handler, next } = harness();
    await handler(req, res, next);
    expect(res.json).toHaveBeenCalledWith(response);
    expect(next).not.toHaveBeenCalled();
    expect(req.listenerCount("aborted")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
});

test("already aborted requests do no database work and return no body", async () => {
    const { req, res, handler, next } = harness();
    req.aborted = true;
    await handler(req, res, next);
    expect(mockReadmit).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(req.listenerCount("aborted")).toBe(0);
});

test("request close cancels the wait and late service completion cannot write a response", async () => {
    const { req, res, handler, next } = harness();
    let release!: (value: unknown) => void;
    mockReadmit.mockImplementation(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    const pending = handler(req, res, next);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockReadmit).toHaveBeenCalledTimes(1);
    res.emit("close");
    await pending;
    release(response);
    await Promise.resolve();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(req.listenerCount("aborted")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
});

test("a hung policy reader gets one static 504 and its late result is ignored", async () => {
    jest.useFakeTimers();
    const { req, res, handler, next } = harness();
    let release!: (value: unknown) => void;
    mockReadmit.mockImplementation(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    const pending = handler(req, res, next);
    await jest.advanceTimersByTimeAsync(RADIO_REQUEST_TIMEOUT_MS);
    await pending;
    expect(res.statusCode).toBe(504);
    expect(res.json).toHaveBeenCalledWith({
        error: "Recommendation queue check timed out",
        code: "QUEUE_ADMISSION_TIMEOUT",
    });
    release(response);
    await Promise.resolve();
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(req.listenerCount("aborted")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
});

test("uses the established error path without returning dependency secrets", async () => {
    mockReadmit.mockRejectedValue(new Error("private database credentials"));
    const result = await request(app)
        .post(path)
        .set("x-test-owner", "alice")
        .send({ references: [reference] });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "Internal server error" });
});
