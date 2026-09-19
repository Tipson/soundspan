import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

const mockYtMusicStream = jest.fn();

jest.mock("../youtubeMusic", () => ({
    ytMusicService: { getStreamProxy: mockYtMusicStream },
}));

import { serveMappedProviderStream } from "../mappedProviderStream";

function responseSink(): Response {
    const sink = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    }) as Writable & Partial<Response>;
    sink.headersSent = false;
    sink.status = jest.fn(() => sink as unknown as Response);
    sink.setHeader = jest.fn();
    return sink as unknown as Response;
}

function failingBody(res: Response, afterBytes: boolean): Readable {
    let read = false;
    return new Readable({
        read() {
            if (read) return;
            read = true;
            if (afterBytes) {
                (res as Response & { headersSent: boolean }).headersSent = true;
                this.push(Buffer.from("audio"));
            }
            this.destroy(new Error("upstream body failed"));
        },
    });
}

describe("mapped provider stream", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it.each([false, true])(
        "reports a destroyed response when the body fails afterBytes=%s",
        async (afterBytes) => {
            const res = responseSink();
            mockYtMusicStream.mockResolvedValueOnce({
                status: 200,
                headers: { "content-type": "audio/webm" },
                data: failingBody(res, afterBytes),
            });

            const result = await serveMappedProviderStream({
                req: { headers: {} } as Request,
                res,
                userId: "user-1",
                quality: "high",
                fallback: {
                    source: "ytmusic",
                    youtubeVideoId: "video-1",
                },
            });

            expect(result).toMatchObject({
                status: "failed",
                responseState: {
                    headersSent: afterBytes,
                    destroyed: true,
                },
            });
            expect(mockYtMusicStream).toHaveBeenCalledWith(
                "__public__",
                "video-1",
                "high",
                undefined,
                { signal: expect.any(AbortSignal) },
            );
        },
    );

    it("passes the selected YouTube identity and quality", async () => {
        const res = responseSink();
        mockYtMusicStream.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: Readable.from([Buffer.from("audio")]),
        });

        await serveMappedProviderStream({
            req: { headers: { range: "bytes=0-99" } } as Request,
            res,
            userId: "user-1",
            youtubeUserId: "oauth-user-1",
            quality: "low",
            fallback: { source: "ytmusic", youtubeVideoId: "video-1" },
        });

        expect(mockYtMusicStream).toHaveBeenCalledWith(
            "oauth-user-1",
            "video-1",
            "low",
            "bytes=0-99",
            { signal: expect.any(AbortSignal) },
        );
    });
    it("does not acquire a provider after the client has already disconnected", async () => {
        const req = Object.assign(new EventEmitter(), {
            headers: {},
            aborted: true,
        });
        const res = responseSink();
        const result = await serveMappedProviderStream({
            req: req as unknown as Request,
            res,
            userId: "user-1",
            quality: "high",
            fallback: { source: "ytmusic", youtubeVideoId: "video-1" },
        });
        expect(result.status).toBe("cancelled");
        expect(mockYtMusicStream).not.toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
        expect(req.listenerCount("aborted")).toBe(0);
        expect(res.listenerCount("close")).toBe(0);
    });
    it("cancels a cold acquisition promptly without recording a provider failure", async () => {
        const req = Object.assign(new EventEmitter(), {
            headers: {},
            aborted: false,
        });
        const res = responseSink();
        let receivedSignal: AbortSignal | undefined;
        let rejectAcquisition!: (error: unknown) => void;
        mockYtMusicStream.mockImplementationOnce(
            (_user, _video, _quality, _range, options) =>
                new Promise((_resolve, reject) => {
                    rejectAcquisition = reject;
                    receivedSignal = options?.signal;
                    receivedSignal?.addEventListener(
                        "abort",
                        () => reject(receivedSignal?.reason),
                        { once: true },
                    );
                }),
        );
        const pending = serveMappedProviderStream({
            req: req as unknown as Request,
            res,
            userId: "user-1",
            quality: "high",
            fallback: { source: "ytmusic", youtubeVideoId: "video-1" },
        });
        await new Promise(setImmediate);
        req.aborted = true;
        req.emit("aborted");
        res.destroy();
        // Let the pre-fix implementation settle too, so the regression fails without hanging Jest.
        rejectAcquisition(new DOMException("Fixture cancelled", "AbortError"));
        const result = await pending;
        expect(receivedSignal?.aborted).toBe(true);
        expect(result.status).toBe("cancelled");
        expect(res.status).not.toHaveBeenCalled();
        expect(req.listenerCount("aborted")).toBe(0);
    });
    it("destroys a late response instead of writing headers after disconnect", async () => {
        const req = Object.assign(new EventEmitter(), {
            headers: {},
            aborted: false,
        });
        const res = responseSink();
        let deliver!: (response: unknown) => void;
        mockYtMusicStream.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    deliver = resolve;
                }),
        );
        const pending = serveMappedProviderStream({
            req: req as unknown as Request,
            res,
            userId: "user-1",
            quality: "high",
            fallback: { source: "ytmusic", youtubeVideoId: "video-1" },
        });
        await new Promise(setImmediate);
        res.destroy();
        const body = Readable.from([Buffer.from("audio")]);
        deliver({
            status: 200,
            headers: { "content-type": "audio/webm" },
            data: body,
        });
        expect((await pending).status).toBe("cancelled");
        expect(body.destroyed).toBe(true);
        expect(res.status).not.toHaveBeenCalled();
        expect(res.setHeader).not.toHaveBeenCalled();
    });
    it("releases an active body on client close without treating it as provider failure", async () => {
        const req = Object.assign(new EventEmitter(), {
            headers: {},
            aborted: false,
        });
        const res = responseSink();
        const body = new Readable({ read() {} });
        mockYtMusicStream.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: body,
        });
        const pending = serveMappedProviderStream({
            req: req as unknown as Request,
            res,
            userId: "user-1",
            quality: "high",
            fallback: { source: "ytmusic", youtubeVideoId: "video-1" },
        });
        await new Promise(setImmediate);
        body.push(Buffer.from("audio"));
        res.destroy();
        expect((await pending).status).toBe("cancelled");
        expect(body.destroyed).toBe(true);
        expect(req.listenerCount("aborted")).toBe(0);
    });
    it("keeps a premature upstream close distinct from listener cancellation", async () => {
        const req = Object.assign(new EventEmitter(), {
            headers: {},
            aborted: false,
        });
        const res = responseSink();
        const body = new Readable({
            read() {
                this.destroy();
            },
        });
        mockYtMusicStream.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: body,
        });
        const result = await serveMappedProviderStream({
            req: req as unknown as Request,
            res,
            userId: "user-1",
            quality: "high",
            fallback: { source: "ytmusic", youtubeVideoId: "video-1" },
        });
        expect(result.status).toBe("failed");
        expect(body.destroyed).toBe(true);
    });
});
