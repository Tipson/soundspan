import assert from "node:assert/strict";
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import test from "node:test";
import { ApiClientCore, type ApiResponseReceipt } from "../../lib/api/core";

class Client extends ApiClientCore {
    captured<T>(
        endpoint: string,
        options: RequestInit = {},
    ): Promise<{
        data: T;
        receipt: ApiResponseReceipt;
    }> {
        return this.requestWithReceipt<T>(endpoint, options);
    }
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                "Response receipt not observed before body completion",
                            ),
                        ),
                    2000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
async function serverFixture(
    run: (base: string) => Promise<void>,
    handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
    const server = createServer(handler);
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        const closed = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        await closed;
    }
}

test("journal receipt is observed at headers before a deliberately incomplete body", async () => {
    const headers = deferred<void>(),
        receipt = deferred<unknown>();
    let response: ServerResponse | undefined;
    let finished = false;
    const controller = new AbortController();
    await serverFixture(
        async (base) => {
            const client = new Client(base);
            const pending = client
                .request("/system/features", {
                    signal: controller.signal,
                    cache: "no-store",
                    retryOnTimeout: false,
                    _onResponseReceipt: (value: unknown) =>
                        receipt.resolve(value),
                } as Parameters<Client["request"]>[1])
                .then((value) => {
                    finished = true;
                    return value;
                });
            // Attach rejection handling before any intentionally failing assertion.
            const settled = pending.catch((error) => error);
            try {
                await bounded(headers.promise);
                const observed = (await bounded(receipt.promise)) as {
                    status: number;
                    receivedMonotonicMs: number;
                    privateNoStore: boolean;
                    retryAfterMs: number | null;
                };
                assert.equal(
                    finished,
                    false,
                    "body completion is still pending",
                );
                assert.equal(observed.status, 200);
                assert.equal(observed.privateNoStore, true);
                assert.equal(observed.retryAfterMs, null);
                assert.ok(Object.isFrozen(observed));
                assert.ok(Number.isFinite(observed.receivedMonotonicMs));
                assert.ok(observed.receivedMonotonicMs <= performance.now());
                assert.deepEqual(
                    Object.keys(observed).sort(),
                    [
                        "status",
                        "receivedMonotonicMs",
                        "privateNoStore",
                        "retryAfterMs",
                    ].sort(),
                );
                response!.end('"ready":true}');
                assert.deepEqual(await pending, { ready: true });
            } finally {
                controller.abort();
                response?.end();
                await settled;
            }
        },
        (_request, res) => {
            response = res;
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "private, no-store",
            });
            res.write("{");
            headers.resolve();
        },
    );
});

test("captured requests retain only final safe metadata and strip the observer from fetch options", async (context) => {
    const nativeFetch = globalThis.fetch;
    let seen = 0;
    context.mock.method(
        globalThis,
        "fetch",
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            assert.equal(Reflect.has(init ?? {}, "_onResponseReceipt"), false);
            seen++;
            return nativeFetch(input, init);
        },
    );
    await serverFixture(
        async (base) => {
            const client = new Client(base);
            const result = await client.captured<{ ok: boolean }>(
                "/system/features",
                { cache: "no-store" },
            );
            assert.deepEqual(result.data, { ok: true });
            assert.equal(result.receipt.status, 200);
            assert.equal(result.receipt.privateNoStore, true);
            assert.equal(result.receipt.retryAfterMs, null);
            assert.equal(seen, 1);
            assert.ok(Object.isFrozen(result.receipt));
        },
        (_request, res) => {
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "PRIVATE, NO-STORE",
                "X-Private-Token": "must-not-escape",
            });
            res.end('{"ok":true}');
        },
    );
});

test("an empty successful response still supplies its status and cache classification", async () => {
    await serverFixture(
        async (base) => {
            const result = await new Client(base).captured("/empty");
            assert.equal(result.data, undefined);
            assert.equal(result.receipt.status, 204);
            assert.equal(result.receipt.privateNoStore, false);
        },
        (_request, res) => {
            res.writeHead(204, { "Cache-Control": "public,max-age=60" });
            res.end();
        },
    );
});

test("Retry-After on a failed journal request is bounded safe metadata, without raw headers", async () => {
    await serverFixture(
        async (base) => {
            await assert.rejects(
                new Client(base).captured("/plays/idempotent", {
                    method: "POST",
                    body: "{}",
                }),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    const value = error as Error & {
                        status: number;
                        retryAfterMs: number;
                        responseReceipt: {
                            status: number;
                            retryAfterMs: number;
                        };
                    };
                    assert.equal(value.status, 503);
                    assert.equal(value.retryAfterMs, 3000);
                    assert.equal(value.responseReceipt.status, 503);
                    assert.equal(value.responseReceipt.retryAfterMs, 3000);
                    assert.ok(Object.isFrozen(value.responseReceipt));
                    assert.equal(
                        JSON.stringify(error).includes("must-not-escape"),
                        false,
                    );
                    return true;
                },
            );
        },
        (_request, res) => {
            res.writeHead(503, {
                "Content-Type": "application/json",
                "Retry-After": "3",
                Date: "Fri, 15 Jan 2027 08:00:00 GMT",
                "X-Private-Token": "must-not-escape",
            });
            res.end('{"error":"Temporarily unavailable"}');
        },
    );
});

test("upstream abort immediately after receipt still cancels body consumption without a POST retry", async () => {
    const controller = new AbortController();
    let requests = 0;
    await serverFixture(
        async (base) => {
            await assert.rejects(
                new Client(base).request("/plays/idempotent", {
                    method: "POST",
                    body: "{}",
                    signal: controller.signal,
                    _onResponseReceipt: () => controller.abort(),
                } as Parameters<Client["request"]>[1]),
                (error: unknown) =>
                    error instanceof Error && error.name === "AbortError",
            );
            assert.equal(requests, 1);
        },
        (_request, res) => {
            requests++;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write("{");
        },
    );
});

test("concurrent receipt requests have independent HTTP responses instead of a shared UI GET", async () => {
    let requests = 0;
    await serverFixture(
        async (base) => {
            const client = new Client(base);
            const results = await Promise.all([
                client.captured<{ request: number }>("/system/features"),
                client.captured<{ request: number }>("/system/features"),
            ]);
            assert.equal(requests, 2);
            assert.deepEqual(
                results.map((value) => value.data.request).sort(),
                [1, 2],
            );
            assert.notEqual(results[0].receipt, results[1].receipt);
        },
        (_request, res) => {
            requests++;
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "private,no-store",
            });
            res.end(JSON.stringify({ request: requests }));
        },
    );
});

test("journal receipt requests force no-store even if a caller supplied a cache preference", async (context) => {
    const nativeFetch = globalThis.fetch;
    context.mock.method(
        globalThis,
        "fetch",
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            assert.equal(init?.cache, "no-store");
            return nativeFetch(input, init);
        },
    );
    await serverFixture(
        async (base) => {
            assert.deepEqual(
                (
                    await new Client(base).captured("/system/features", {
                        cache: "force-cache",
                    })
                ).data,
                { ok: true },
            );
        },
        (_request, res) => {
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": "private,no-store",
            });
            res.end('{"ok":true}');
        },
    );
});

test("malformed HTTP error messages retain status and Retry-After instead of throwing during coercion", async () => {
    let body = "null",
        status = 429;
    await serverFixture(
        async (base) => {
            for (const code of [429, 503])
                for (const raw of ["null", '{"error":{"toString":1}}']) {
                    body = raw;
                    status = code;
                    await assert.rejects(
                        new Client(base).captured("/plays/idempotent", {
                            method: "POST",
                            body: "{}",
                        }),
                        (error: unknown) => {
                            assert.ok(error instanceof Error);
                            const value = error as Error & {
                                status: number;
                                retryAfterMs: number;
                                responseReceipt: { status: number };
                            };
                            assert.equal(value.status, code);
                            assert.equal(value.retryAfterMs, 37000);
                            assert.equal(value.responseReceipt.status, code);
                            return true;
                        },
                    );
                }
        },
        (_request, res) => {
            res.writeHead(status, {
                "Content-Type": "application/json",
                "Retry-After": "37",
            });
            res.end(body);
        },
    );
});

test("private no-store directives cannot be forged inside a quoted Cache-Control extension", async () => {
    let policy = "";
    await serverFixture(
        async (base) => {
            for (const [value, expected] of [
                ['public, extension="x, private, no-store, y"', false],
                ['private, extension="x, no-store, y"', false],
                ['private, no-store, extension="x, \\"quote\\", y"', true],
                ['private, no-store, extension="unfinished', false],
            ] as const) {
                policy = value;
                const result = await new Client(base).captured(
                    "/system/features",
                );
                assert.equal(result.receipt.privateNoStore, expected, value);
            }
        },
        (_request, res) => {
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Cache-Control": policy,
            });
            res.end("{}");
        },
    );
});
