import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import {
    acquireAbortableStreamProxy,
    createStreamProxyRequestAbort,
} from "../streamProxyRequestAbort";

function createHarness() {
    const req = new EventEmitter() as Request;
    const res = new EventEmitter() as Response;
    Object.defineProperty(req, "aborted", {
        value: false,
        writable: true,
    });
    Object.defineProperty(res, "writableEnded", {
        value: false,
        writable: true,
    });
    return { req, res };
}

describe("stream proxy request abort", () => {
    it("aborts a pending provider request when the browser cancels playback", () => {
        const { req, res } = createHarness();
        const scope = createStreamProxyRequestAbort(req, res);

        req.aborted = true;
        req.emit("aborted");

        expect(scope.signal.aborted).toBe(true);
        expect(scope.wasClientAborted()).toBe(true);
    });

    it("does not classify a normal completed response close as a client abort", () => {
        const { req, res } = createHarness();
        const scope = createStreamProxyRequestAbort(req, res);

        Object.defineProperty(res, "writableEnded", {
            value: true,
            writable: true,
        });
        res.emit("close");

        expect(scope.signal.aborted).toBe(false);
        expect(scope.wasClientAborted()).toBe(false);
    });

    it("removes listeners when provider acquisition has finished", () => {
        const { req, res } = createHarness();
        const scope = createStreamProxyRequestAbort(req, res);

        scope.dispose();
        req.emit("aborted");
        res.emit("close");

        expect(scope.signal.aborted).toBe(false);
        expect(scope.wasClientAborted()).toBe(false);
    });

    it("returns null instead of reporting a superseded acquisition as a provider failure", async () => {
        const { req, res } = createHarness();
        const acquisition = acquireAbortableStreamProxy(
            req,
            res,
            (signal) =>
                new Promise<string>((_resolve, reject) => {
                    signal.addEventListener("abort", () =>
                        reject(new Error("aborted")),
                    );
                }),
        );

        req.aborted = true;
        req.emit("aborted");

        await expect(acquisition).resolves.toBeNull();
    });

    it("preserves a real provider acquisition error", async () => {
        const { req, res } = createHarness();
        const failure = new Error("provider failed");

        await expect(
            acquireAbortableStreamProxy(req, res, async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);
    });

    it("drops a late provider result even when the provider ignores AbortSignal", async () => {
        const { req, res } = createHarness();
        let resolveProvider!: (value: string) => void;
        const acquisition = acquireAbortableStreamProxy(
            req,
            res,
            () =>
                new Promise<string>((resolve) => {
                    resolveProvider = resolve;
                }),
        );

        req.aborted = true;
        req.emit("aborted");
        resolveProvider("late stream");

        await expect(acquisition).resolves.toBeNull();
    });
});
