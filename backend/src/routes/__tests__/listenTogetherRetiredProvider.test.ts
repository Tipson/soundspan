import type { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: Request, _res: Response, next: () => void) => {
        req.user = { id: "user-1", username: "tester", role: "user" };
        next();
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn(),
        error: jest.fn(),
    },
}));

const mockCreateGroup = jest.fn();
jest.mock("../../services/listenTogether", () => ({
    createGroup: (...args: unknown[]) => mockCreateGroup(...args),
    joinGroup: jest.fn(),
    discoverGroups: jest.fn(),
    getActiveGroupCount: jest.fn(),
    getMyGroup: jest.fn(),
    leaveGroup: jest.fn(),
    endGroup: jest.fn(),
}));

jest.mock("../../services/listenTogetherManager", () => ({
    GroupError: class GroupError extends Error {
        constructor(
            public readonly code: string,
            message: string,
        ) {
            super(message);
        }
    },
}));

import router from "../listenTogether";

function getCreateHandler() {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === "/" && entry.route?.methods?.post,
    );
    if (!layer) throw new Error("POST / route not found");
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };
    return res;
}

describe("Listen Together retired provider boundary", () => {
    const createHandler = getCreateHandler();

    beforeEach(() => {
        jest.clearAllMocks();
        mockCreateGroup.mockResolvedValue({ id: "group-1" });
    });

    it("rejects a retired TIDAL queue before creating or mutating a group", async () => {
        const req = {
            user: { id: "user-1", username: "tester", role: "user" },
            body: {
                queueTracks: [
                    {
                        tidalTrackId: 991,
                        title: "Legacy",
                        artist: "Retired Artist",
                        album: "Retired Album",
                        duration: 180,
                    },
                ],
            },
        } as any;
        const res = createRes();

        await createHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "retired_provider" });
        expect(mockCreateGroup).not.toHaveBeenCalled();
    });

    it("rejects a TIDAL-prefixed pseudo-local queue id", async () => {
        const req = {
            user: { id: "user-1", username: "tester", role: "user" },
            body: { queueTracks: [{ trackId: "tidal:991" }] },
        } as any;
        const res = createRes();

        await createHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "retired_provider" });
        expect(mockCreateGroup).not.toHaveBeenCalled();
    });

    it("rejects a TIDAL-prefixed legacy queueTrackIds entry", async () => {
        const req = {
            user: { id: "user-1", username: "tester", role: "user" },
            body: { queueTrackIds: ["tidal:991"] },
        } as any;
        const res = createRes();

        await createHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "retired_provider" });
        expect(mockCreateGroup).not.toHaveBeenCalled();
    });

    it("passes a normal local queue reference to group creation", async () => {
        const req = {
            user: { id: "user-1", username: "tester", role: "user" },
            body: { queueTracks: [{ trackId: "local-track-1" }] },
        } as any;
        const res = createRes();

        await createHandler(req, res);

        expect(res.statusCode).toBe(201);
        expect(mockCreateGroup).toHaveBeenCalledWith("user-1", "tester", {
            queueTracks: [{ trackId: "local-track-1" }],
        });
    });
});
