import axios, { type AxiosResponse } from "axios";
import { once } from "node:events";
import http from "node:http";
import type { Readable } from "node:stream";

jest.mock("../../config", () => ({
    config: {
        ytmusicStreamer: { url: "http://127.0.0.1:1" },
        internalApiSecret: undefined,
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import { ytMusicService } from "../youtubeMusic";

type Observed<T> = {
    state: "pending" | "fulfilled" | "rejected";
    value?: T;
    error?: unknown;
    settled: Promise<void>;
};

function observe<T>(promise: Promise<T>): Observed<T> {
    const observed: Observed<T> = {
        state: "pending",
        settled: Promise.resolve(),
    };
    observed.settled = promise.then(
        (value) => {
            observed.state = "fulfilled";
            observed.value = value;
        },
        (error: unknown) => {
            observed.state = "rejected";
            observed.error = error;
        },
    );
    return observed;
}

function countPending(agent: http.Agent): number {
    return Object.values(agent.requests).reduce(
        (total, requests) => total + (requests?.length ?? 0),
        0,
    );
}

function countAgentEntries(
    entries: Record<string, unknown[] | undefined>,
): number {
    return Object.values(entries).reduce(
        (total, values) => total + (values?.length ?? 0),
        0,
    );
}

async function waitForAgentClose(agent: http.Agent): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
            countAgentEntries(agent.sockets) === 0 &&
            countAgentEntries(agent.freeSockets) === 0 &&
            countPending(agent) === 0
        ) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("Loopback Agent sockets did not close");
}

function immediate(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

class HeldSidecar {
    readonly server = http.createServer((request, response) => {
        const path = request.url ?? "";
        this.paths.push(path);
        this.sockets.push(request.socket);
        request.resume();
        if (!path.startsWith("/proxy/before-headers-")) {
            const rejectedStatus = path.match(
                /^\/proxy\/rejected-(401|503)-/,
            )?.[1];
            response.writeHead(rejectedStatus ? Number(rejectedStatus) : 200, {
                "content-type": path.startsWith("/proxy/")
                    ? "audio/webm"
                    : "application/json",
                "transfer-encoding": "chunked",
            });
            response.flushHeaders();
        }
        this.responses.push({ path, response });
        this.resolveDispatchWaiters();
    });
    readonly paths: string[] = [];
    readonly sockets: import("node:net").Socket[] = [];
    readonly responses: Array<{
        path: string;
        response: http.ServerResponse;
    }> = [];
    private readonly dispatchWaiters: Array<{
        prefix: string;
        count: number;
        resolve: () => void;
    }> = [];

    async start(): Promise<string> {
        this.server.listen(0, "127.0.0.1");
        await once(this.server, "listening");
        const address = this.server.address();
        if (!address || typeof address === "string") {
            throw new Error("Expected loopback TCP listener");
        }
        return `http://127.0.0.1:${address.port}`;
    }

    count(prefix: string): number {
        return this.paths.filter((path) => path.startsWith(prefix)).length;
    }

    waitFor(prefix: string, count: number): Promise<void> {
        if (this.count(prefix) >= count) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(
                    new Error(
                        `Timed out waiting for ${count} ${prefix} requests; observed ${this.count(prefix)}`,
                    ),
                );
            }, 2_000);
            this.dispatchWaiters.push({
                prefix,
                count,
                resolve: () => {
                    clearTimeout(timer);
                    resolve();
                },
            });
        });
    }

    endOne(prefix: string): void {
        const held = this.responses.find(
            (entry) =>
                entry.path.startsWith(prefix) && !entry.response.writableEnded,
        );
        if (!held) throw new Error(`No held response for ${prefix}`);
        held.response.end(
            prefix === "/proxy/"
                ? Buffer.from("audio")
                : JSON.stringify({ results: [], total: 0 }),
        );
    }

    endAll(): void {
        for (const held of this.responses) {
            if (held.response.writableEnded) continue;
            held.response.end(
                held.path.startsWith("/proxy/")
                    ? Buffer.from("audio")
                    : JSON.stringify({ results: [], total: 0 }),
            );
        }
    }

    async close(): Promise<void> {
        this.endAll();
        await new Promise<void>((resolve) => {
            this.server.close(() => resolve());
            this.server.closeAllConnections();
        });
    }

    private resolveDispatchWaiters(): void {
        for (
            let index = this.dispatchWaiters.length - 1;
            index >= 0;
            index -= 1
        ) {
            const waiter = this.dispatchWaiters[index];
            if (!waiter || this.count(waiter.prefix) < waiter.count) continue;
            this.dispatchWaiters.splice(index, 1);
            waiter.resolve();
        }
    }
}

describe("YouTube Music bounded transport admission", () => {
    it("bounds the 120-active interactive queue before Axios and removes cancelled waiters", async () => {
        const sidecar = new HeldSidecar();
        const origin = await sidecar.start();
        const service = ytMusicService as unknown as {
            client: import("axios").AxiosInstance;
        };
        service.client.defaults.baseURL = origin;
        const activeResponses: AxiosResponse<Readable>[] = [];
        const activeControllers: AbortController[] = [];
        const controllers: AbortController[] = [];
        const observed: Array<Observed<unknown>> = [];
        let agent: http.Agent | undefined;

        try {
            const active = await Promise.all(
                Array.from({ length: 120 }, (_unused, index) => {
                    const controller = new AbortController();
                    activeControllers.push(controller);
                    return ytMusicService.getStreamProxy(
                        "__public__",
                        `interactive-active-${index}`,
                        "high",
                        undefined,
                        {
                            purpose: "interactive",
                            timeoutMs: 10_000,
                            signal: controller.signal,
                        },
                    );
                }),
            );
            activeResponses.push(...active);
            await sidecar.waitFor("/proxy/", 120);
            agent = active[0]?.request?.agent as http.Agent | undefined;
            expect(agent).toBeDefined();

            activeControllers[0]!.abort();
            const activeReplacementController = new AbortController();
            activeControllers.push(activeReplacementController);
            const activeReplacement = observe(
                ytMusicService.getStreamProxy(
                    "__public__",
                    "interactive-after-headers-replacement",
                    "high",
                    undefined,
                    {
                        purpose: "interactive",
                        timeoutMs: 10_000,
                        signal: activeReplacementController.signal,
                    },
                ),
            );
            await immediate();
            expect(countPending(agent!)).toBe(0);
            await sidecar.waitFor("/proxy/", 121);
            await activeReplacement.settled;
            expect(activeReplacement.state).toBe("fulfilled");
            activeResponses.push(
                activeReplacement.value as AxiosResponse<Readable>,
            );

            for (let index = 0; index < 120; index += 1) {
                const controller = new AbortController();
                controllers.push(controller);
                observed.push(
                    observe(
                        ytMusicService.getStreamProxy(
                            "__public__",
                            `interactive-queued-${index}`,
                            "high",
                            undefined,
                            {
                                purpose: "interactive",
                                timeoutMs: 10_000,
                                signal: controller.signal,
                            },
                        ),
                    ),
                );
            }
            await immediate();
            expect(sidecar.count("/proxy/")).toBe(121);
            expect(countPending(agent!)).toBe(0);

            const overflowController = new AbortController();
            controllers.push(overflowController);
            const overflow = observe(
                ytMusicService.getStreamProxy(
                    "__public__",
                    "interactive-overflow",
                    "high",
                    undefined,
                    {
                        purpose: "interactive",
                        timeoutMs: 10_000,
                        signal: overflowController.signal,
                    },
                ),
            );
            observed.push(overflow);
            await immediate();
            expect(overflow.state).toBe("rejected");
            expect(overflow.error).toMatchObject({ response: { status: 503 } });

            controllers[0]!.abort();
            await observed[0]!.settled;
            expect(observed[0]!.error).toMatchObject({ name: "AbortError" });

            await expect(
                ytMusicService.getStreamProxy(
                    "__public__",
                    "interactive-deadline",
                    "high",
                    undefined,
                    { purpose: "interactive", timeoutMs: 10 },
                ),
            ).rejects.toMatchObject({ response: { status: 504 } });
            expect(sidecar.count("/proxy/")).toBe(121);
            expect(countPending(agent!)).toBe(0);

            const replacementController = new AbortController();
            controllers.push(replacementController);
            const replacement = observe(
                ytMusicService.getStreamProxy(
                    "__public__",
                    "interactive-replacement",
                    "high",
                    undefined,
                    {
                        purpose: "interactive",
                        timeoutMs: 10_000,
                        signal: replacementController.signal,
                    },
                ),
            );
            observed.push(replacement);
            await immediate();
            expect(replacement.state).toBe("pending");
            expect(sidecar.count("/proxy/")).toBe(121);

            activeResponses[1]!.data.resume();
            sidecar.endOne("/proxy/interactive-active-1");
            await sidecar.waitFor("/proxy/", 122);
            expect(sidecar.paths.at(-1)).toContain("interactive-queued-1");
            expect(countPending(agent!)).toBe(0);
        } finally {
            for (const controller of activeControllers) controller.abort();
            for (const controller of controllers) controller.abort();
            await Promise.allSettled(observed.map((entry) => entry.settled));
            for (const response of activeResponses) {
                response.data.resume();
                response.data.on("error", () => undefined);
            }
            sidecar.endAll();
            await sidecar.close();
            agent?.destroy();
            if (agent) await waitForAgentClose(agent);
        }
    }, 20_000);

    it("closes rejected streaming response bodies before reusing background capacity", async () => {
        const sidecar = new HeldSidecar();
        const origin = await sidecar.start();
        const service = ytMusicService as unknown as {
            client: import("axios").AxiosInstance;
        };
        service.client.defaults.baseURL = origin;
        const rejected = [401, 503, 401, 503, 401, 503, 401, 503].map(
            (status, index) =>
                observe(
                    ytMusicService.getStreamProxy(
                        "__public__",
                        `rejected-${status}-${index}`,
                        "high",
                        undefined,
                        { purpose: "preload", timeoutMs: 10_000 },
                    ),
                ),
        );
        let agent: http.Agent | undefined;
        let probeResponse: AxiosResponse<Readable> | undefined;

        try {
            await sidecar.waitFor("/proxy/", 8);
            await Promise.all(rejected.map((entry) => entry.settled));
            for (let index = 0; index < rejected.length; index += 1) {
                expect(rejected[index]!.error).toMatchObject({
                    response: { status: index % 2 === 0 ? 401 : 503 },
                });
            }
            agent = (
                rejected[0]!.error as {
                    request?: { agent?: http.Agent };
                }
            ).request?.agent;
            expect(agent).toBeDefined();

            const probe = observe(
                ytMusicService.getStreamProxy(
                    "__public__",
                    "rejected-response-capacity-probe",
                    "high",
                    undefined,
                    { purpose: "preload", timeoutMs: 10_000 },
                ),
            );
            await immediate();
            expect(countPending(agent!)).toBe(0);
            await sidecar.waitFor("/proxy/", 9);
            await probe.settled;
            expect(probe.state).toBe("fulfilled");
            probeResponse = probe.value as AxiosResponse<Readable>;
        } finally {
            probeResponse?.data.resume();
            sidecar.endAll();
            await sidecar.close();
            agent?.destroy();
            if (agent) await waitForAgentClose(agent);
        }
    }, 20_000);

    it("keeps background cancellation before headers out of the Agent queue", async () => {
        const sidecar = new HeldSidecar();
        const origin = await sidecar.start();
        const service = ytMusicService as unknown as {
            client: import("axios").AxiosInstance;
        };
        service.client.defaults.baseURL = origin;
        const controllers: AbortController[] = [];
        const active: Array<Observed<unknown>> = [];
        let agent: http.Agent | undefined;

        try {
            const probe = await ytMusicService.getStreamProxy(
                "__public__",
                "background-agent-probe",
                "high",
                undefined,
                { purpose: "preload", timeoutMs: 10_000 },
            );
            agent = probe.request.agent as http.Agent;
            const probeEnded = once(probe.data as Readable, "end");
            (probe.data as Readable).resume();
            sidecar.endOne("/proxy/background-agent-probe");
            await probeEnded;

            for (let index = 0; index < 8; index += 1) {
                const controller = new AbortController();
                controllers.push(controller);
                active.push(
                    observe(
                        ytMusicService.getStreamProxy(
                            "__public__",
                            `before-headers-background-${index}`,
                            "high",
                            undefined,
                            {
                                purpose: "preload",
                                timeoutMs: 10_000,
                                signal: controller.signal,
                            },
                        ),
                    ),
                );
            }
            await sidecar.waitFor("/proxy/", 9);

            controllers[0]!.abort();
            await active[0]!.settled;
            expect(active[0]!.error).toMatchObject({
                name: "CanceledError",
                code: "ERR_CANCELED",
            });

            const replacementController = new AbortController();
            controllers[0] = replacementController;
            const replacement = observe(
                ytMusicService.getStreamProxy(
                    "__public__",
                    "before-headers-background-replacement",
                    "high",
                    undefined,
                    {
                        purpose: "preload",
                        timeoutMs: 10_000,
                        signal: replacementController.signal,
                    },
                ),
            );
            active[0] = replacement;
            await immediate();
            expect(countPending(agent)).toBe(0);
            await sidecar.waitFor("/proxy/", 10);
        } finally {
            for (const controller of controllers) controller.abort();
            await Promise.allSettled(active.map((entry) => entry.settled));
            sidecar.endAll();
            await sidecar.close();
            agent?.destroy();
            if (agent) await waitForAgentClose(agent);
        }
    }, 20_000);

    it("bounds the 16-active control queue before Axios and removes cancelled waiters", async () => {
        const sidecar = new HeldSidecar();
        const origin = await sidecar.start();
        const service = ytMusicService as unknown as {
            client: import("axios").AxiosInstance;
        };
        service.client.defaults.baseURL = origin;
        const agent = service.client.defaults.httpAgent as http.Agent;
        const active: Array<Observed<unknown>> = [];
        const controllers: AbortController[] = [];
        const observed: Array<Observed<unknown>> = [];

        try {
            for (let index = 0; index < 16; index += 1) {
                active.push(
                    observe(
                        ytMusicService.search(
                            "__public__",
                            `control-active-${index}`,
                            "songs",
                            1,
                            { timeoutMs: 10_000, maxRetries: 0 },
                        ),
                    ),
                );
            }
            await sidecar.waitFor("/search", 16);

            for (let index = 0; index < 128; index += 1) {
                const controller = new AbortController();
                controllers.push(controller);
                observed.push(
                    observe(
                        ytMusicService.search(
                            "__public__",
                            `control-queued-${index}`,
                            "songs",
                            1,
                            {
                                timeoutMs: 10_000,
                                maxRetries: 0,
                                signal: controller.signal,
                            },
                        ),
                    ),
                );
            }
            await immediate();
            expect(sidecar.count("/search")).toBe(16);
            expect(countPending(agent)).toBe(0);

            const overflowController = new AbortController();
            controllers.push(overflowController);
            const overflow = observe(
                ytMusicService.search(
                    "__public__",
                    "control-overflow",
                    "songs",
                    1,
                    {
                        timeoutMs: 10_000,
                        maxRetries: 0,
                        signal: overflowController.signal,
                    },
                ),
            );
            observed.push(overflow);
            await immediate();
            expect(overflow.state).toBe("rejected");
            expect(overflow.error).toMatchObject({ response: { status: 503 } });

            controllers[0]!.abort();
            await observed[0]!.settled;
            expect(observed[0]!.error).toMatchObject({
                name: "CanceledError",
                code: "ERR_CANCELED",
            });

            await expect(
                ytMusicService.search(
                    "__public__",
                    "control-deadline",
                    "songs",
                    1,
                    { timeoutMs: 10, maxRetries: 0 },
                ),
            ).rejects.toMatchObject({ response: { status: 504 } });
            expect(sidecar.count("/search")).toBe(16);
            expect(countPending(agent)).toBe(0);

            const replacementController = new AbortController();
            controllers.push(replacementController);
            const replacement = observe(
                ytMusicService.search(
                    "__public__",
                    "control-replacement",
                    "songs",
                    1,
                    {
                        timeoutMs: 10_000,
                        maxRetries: 0,
                        signal: replacementController.signal,
                    },
                ),
            );
            observed.push(replacement);
            await immediate();
            expect(replacement.state).toBe("pending");
            expect(sidecar.count("/search")).toBe(16);

            sidecar.endOne("/search");
            await sidecar.waitFor("/search", 17);
            expect(sidecar.paths.at(-1)).toBe("/search?user_id=__public__");
            expect(sidecar.sockets[16]).toBe(sidecar.sockets[0]);
            expect(countPending(agent)).toBe(0);
        } finally {
            for (const controller of controllers) controller.abort();
            await Promise.allSettled(observed.map((entry) => entry.settled));
            sidecar.endAll();
            await Promise.allSettled(active.map((entry) => entry.settled));
            await sidecar.close();
            agent.destroy();
            await waitForAgentClose(agent);
        }
    }, 20_000);

    it("does not leak control permits when Axios rejects before or inside its adapter", async () => {
        const sidecar = new HeldSidecar();
        const origin = await sidecar.start();
        const service = ytMusicService as unknown as {
            client: import("axios").AxiosInstance;
        };
        const client = service.client;
        client.defaults.baseURL = origin;
        const agent = client.defaults.httpAgent as http.Agent;
        const active: Array<Observed<unknown>> = [];
        let rejectingInterceptor: number | undefined;

        try {
            const preAborted = new AbortController();
            preAborted.abort();
            await expect(
                ytMusicService.search("__public__", "pre-aborted", "songs", 1, {
                    timeoutMs: 10_000,
                    maxRetries: 0,
                    signal: preAborted.signal,
                }),
            ).rejects.toMatchObject({ name: "AbortError" });

            await expect(
                client.post(
                    "/search",
                    { query: "transform-failure" },
                    {
                        transformRequest: [
                            () => {
                                throw new Error("transform rejected");
                            },
                        ],
                    },
                ),
            ).rejects.toThrow("transform rejected");

            rejectingInterceptor = client.interceptors.request.use(() =>
                Promise.reject(new Error("interceptor rejected")),
            );
            await expect(client.get("/health")).rejects.toThrow(
                "interceptor rejected",
            );
            client.interceptors.request.eject(rejectingInterceptor);
            rejectingInterceptor = undefined;

            await expect(client.get("http://[::1")).rejects.toThrow();

            const earlyAbort = new AbortController();
            const originalRequest = http.request;
            const requestSpy = jest.spyOn(http, "request").mockImplementation(((
                ...args: unknown[]
            ) => {
                const request = Reflect.apply(
                    originalRequest,
                    http,
                    args,
                ) as http.ClientRequest;
                queueMicrotask(() => earlyAbort.abort());
                return request;
            }) as typeof http.request);
            try {
                await expect(
                    ytMusicService.search(
                        "__public__",
                        "abort-before-socket-assignment",
                        "songs",
                        1,
                        {
                            timeoutMs: 10_000,
                            maxRetries: 0,
                            signal: earlyAbort.signal,
                        },
                    ),
                ).rejects.toMatchObject({ code: "ERR_CANCELED" });
            } finally {
                requestSpy.mockRestore();
            }
            const requestsBeforeCapacityProbe = sidecar.count("/search");

            for (let index = 0; index < 16; index += 1) {
                active.push(
                    observe(
                        ytMusicService.search(
                            "__public__",
                            `control-after-fault-${index}`,
                            "songs",
                            1,
                            { timeoutMs: 10_000, maxRetries: 0 },
                        ),
                    ),
                );
            }
            await sidecar.waitFor("/search", requestsBeforeCapacityProbe + 16);
            expect(sidecar.count("/search")).toBe(
                requestsBeforeCapacityProbe + 16,
            );
            expect(countPending(agent)).toBe(0);
        } finally {
            if (rejectingInterceptor !== undefined) {
                client.interceptors.request.eject(rejectingInterceptor);
            }
            sidecar.endAll();
            await Promise.allSettled(active.map((entry) => entry.settled));
            await sidecar.close();
            agent.destroy();
            await waitForAgentClose(agent);
        }
    }, 20_000);

    it("does not move rapid active-control cancellations back into the Agent queue", async () => {
        const sidecar = new HeldSidecar();
        const origin = await sidecar.start();
        const service = ytMusicService as unknown as {
            client: import("axios").AxiosInstance;
        };
        service.client.defaults.baseURL = origin;
        const agent = service.client.defaults.httpAgent as http.Agent;
        const controllers: AbortController[] = [];
        const active: Array<Observed<unknown>> = [];

        try {
            for (let index = 0; index < 16; index += 1) {
                const controller = new AbortController();
                controllers.push(controller);
                active.push(
                    observe(
                        ytMusicService.search(
                            "__public__",
                            `churn-initial-${index}`,
                            "songs",
                            1,
                            {
                                timeoutMs: 10_000,
                                maxRetries: 0,
                                signal: controller.signal,
                            },
                        ),
                    ),
                );
            }
            await sidecar.waitFor("/search", 16);

            for (let cycle = 0; cycle < 32; cycle += 1) {
                const slot = cycle % 16;
                controllers[slot]!.abort();
                await active[slot]!.settled;

                const replacementController = new AbortController();
                const replacement = observe(
                    ytMusicService.search(
                        "__public__",
                        `churn-replacement-${cycle}`,
                        "songs",
                        1,
                        {
                            timeoutMs: 10_000,
                            maxRetries: 0,
                            signal: replacementController.signal,
                        },
                    ),
                );
                controllers[slot] = replacementController;
                active[slot] = replacement;
                await immediate();
                expect(countPending(agent)).toBe(0);
                await sidecar.waitFor("/search", 17 + cycle);
            }
        } finally {
            for (const controller of controllers) controller.abort();
            await Promise.allSettled(active.map((entry) => entry.settled));
            sidecar.endAll();
            await sidecar.close();
            agent.destroy();
            await waitForAgentClose(agent);
        }
    }, 20_000);
});
