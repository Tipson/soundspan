import { EventEmitter } from "node:events";
import type { Request, Response, RequestHandler } from "express";
const mockRecommend = jest.fn();
jest.mock("../../middleware/auth", () => ({ requireAuthOrToken: jest.fn() }));
jest.mock("../../services/recommendations/recommendationRuntime", () => ({
    unifiedRecommendationService: {
        recommendRadio: (...args: unknown[]) => mockRecommend(...args),
    },
}));
jest.mock("../../services/personalDailyMixes", () => ({
    personalDailyMixService: {},
}));
jest.mock("../../services/recommendations/exposureStore", () => ({
    recommendationExposureStore: {},
}));
import router from "../personalized";
import { RadioRequestError } from "../../services/recommendations/radioRequestExecution";

const handler: RequestHandler = router.stack.find(
    (layer) => layer.route?.path === "/radio",
)!.route!.stack[0].handle;
function harness() {
    const req = Object.assign(new EventEmitter(), {
        query: { type: "artist-name", value: "Artist" },
        headers: {},
        user: { id: "alice" },
        aborted: false,
    }) as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
        writableEnded: false,
        destroyed: false,
        statusCode: 200,
    }) as unknown as Response;
    res.status = jest.fn((code) => {
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
    const next = jest.fn();
    return { req, res, next };
}
beforeEach(() => jest.resetAllMocks());

test("returns a static 504 for deadline rather than the generic error path", async () => {
    const { req, res, next } = harness();
    mockRecommend.mockRejectedValue(
        new RadioRequestError("RADIO_REQUEST_TIMEOUT"),
    );
    await handler(req, res, next);
    expect(res.statusCode).toBe(504);
    expect(res.json).toHaveBeenCalledWith({
        error: "Radio request timed out",
        code: "RADIO_REQUEST_TIMEOUT",
    });
    expect(next).not.toHaveBeenCalled();
    expect(req.listenerCount("aborted")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
});

test("premature close cancels only the server scope and drops a late result", async () => {
    const { req, res, next } = harness();
    let release!: (value: unknown) => void;
    mockRecommend.mockImplementation(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    const work = handler(req, res, next);
    await Promise.resolve();
    res.emit("close");
    const signal = mockRecommend.mock.calls[0][1]?.signal;
    release({ tracks: [] });
    await work;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
    expect(res.json).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(req.listenerCount("aborted")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
});

test("already closed request does no service work", async () => {
    const { req, res, next } = harness();
    req.aborted = true;
    mockRecommend.mockResolvedValue({ tracks: [] });
    await handler(req, res, next);
    expect(mockRecommend).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
});

test("ordinary completed response remains successful and releases listeners", async () => {
    const { req, res, next } = harness();
    const body = { tracks: [] };
    mockRecommend.mockResolvedValue(body);
    await handler(req, res, next);
    res.emit("close");
    expect(res.json).toHaveBeenCalledWith(body);
    expect(next).not.toHaveBeenCalled();
    const signal = mockRecommend.mock.calls[0][1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(req.listenerCount("aborted")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
});
