import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import test, { after, beforeEach } from "node:test";
import { ApiClientCore, SupersededAuthSessionError } from "../../lib/api/core";
import { WithPlays } from "../../lib/api/plays";
import { PLAY_CREATE_LOGIN_FENCE_KEY } from "../../lib/playCreateLoginFence";
import {
    admitPlayCreateGrant,
    type PlayCreateBinding,
    type PlayCreatePayload,
} from "../../lib/playCreateJournal";

// Keep native fetch/AbortSignal: only browser credential storage needs a fixture.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
);
const stored = new Map<string, string>();
const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
        stored.set(key, value);
    },
    removeItem: (key: string) => {
        stored.delete(key);
    },
    clear: () => stored.clear(),
};
Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { localStorage: storage }),
});
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
});
beforeEach(() => stored.clear());
after(() => {
    if (originalWindow)
        Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage)
        Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

class Client extends WithPlays(ApiClientCore) {}
const key = "p1.7.mjt91xc0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const expiry = "2026-01-01T00:00:00.000Z";
const youtube: PlayCreatePayload = Object.freeze({
    source: "youtube",
    wireJson:
        '{"youtubeVideoId":"exact-video","title":"Track","artist":"Artist","album":"Album","duration":120}',
});
const engagement = {
    listenedSeconds: 60,
    completionRatio: 0.5,
    outcome: "meaningful" as const,
};
function policy(overrides: Record<string, unknown> = {}) {
    return {
        version: 1,
        newCreationsEnabled: true,
        replaySupported: true,
        createPath: "/api/plays/idempotent",
        ownerHistoryEpoch: 7,
        serverNowMs: 1_767_225_600_000,
        replayWindowSeconds: 86_400,
        futureSkewSeconds: 300,
        capabilityTtlSeconds: 60,
        allowedSources: ["youtube", "vk", "yandex"],
        ...overrides,
    };
}
function ack(overrides: Record<string, unknown> = {}) {
    return {
        id: "play-id",
        playCreation: {
            version: 1,
            clientPlaybackId: key,
            disposition: "created",
            replayExpiresAt: expiry,
        },
        ...overrides,
    };
}
function json(
    response: ServerResponse,
    data: unknown,
    status = 200,
    headers: Record<string, string> = {},
) {
    response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "private,no-store",
        ...headers,
    });
    response.end(JSON.stringify(data));
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
                    () => reject(new Error("HTTP fixture did not settle")),
                    3000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
type RequestRecord = {
    method: string | undefined;
    url: string | undefined;
    body: string;
    authorization: string | undefined;
};
async function fixture(
    run: (client: Client, requests: RequestRecord[]) => Promise<void>,
    handle: (
        request: RequestRecord,
        response: ServerResponse,
        raw: IncomingMessage,
    ) => void,
) {
    const requests: RequestRecord[] = [];
    const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (part: string) => {
            body += part;
        });
        request.on("end", () => {
            const row = {
                method: request.method,
                url: request.url,
                body,
                authorization: request.headers.authorization,
            };
            requests.push(row);
            handle(row, response, request);
        });
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new Client(`http://127.0.0.1:${address.port}`);
    client.setToken("fixture-access", "fixture-refresh");
    try {
        await run(client, requests);
    } finally {
        client.clearToken();
        const closed = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        await closed;
    }
}
const network = { isOnline: () => true, getGeneration: () => 3 };
function binding(client: Client): PlayCreateBinding {
    const loginNonce = client.getPlayCreateLoginNonce();
    assert.ok(loginNonce);
    return Object.freeze({
        ownerId: "owner-a",
        loginNonce,
        authGeneration: client.getSessionGeneration(),
        networkGeneration: 3,
    });
}

test("fresh grants use independent private identity and feature HTTP reads without UI GET coalescing", async (context) => {
    const nativeFetch = globalThis.fetch;
    context.mock.method(
        globalThis,
        "fetch",
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            assert.equal(init?.cache, "no-store");
            assert.ok(init?.signal);
            return nativeFetch(input, init);
        },
    );
    await fixture(
        async (client, requests) => {
            const grants = await Promise.all([
                client.getPlayCreationGrant({ network }),
                client.getPlayCreationGrant({ network }),
            ]);
            assert.equal(
                requests.filter((row) => row.url === "/api/auth/me").length,
                2,
            );
            assert.equal(
                requests.filter((row) => row.url === "/api/system/features")
                    .length,
                2,
            );
            assert.ok(grants[0] && grants[1]);
            assert.notEqual(grants[0], grants[1]);
            assert.deepEqual(grants[0].binding, binding(client));
            assert.ok(
                admitPlayCreateGrant(grants[0], {
                    binding: binding(client),
                    online: true,
                    nowMonotonicMs: performance.now(),
                    intent: { kind: "new", source: "youtube" },
                }),
            );
        },
        (request, response) =>
            json(
                response,
                request.url === "/api/auth/me"
                    ? { id: "owner-a" }
                    : { playCreation: policy() },
            ),
    );
});

test("unknown, disabled, malformed and nonprivate capabilities close compatibly while producer rollback permits restoration", async () => {
    let selected: { data: unknown; status?: number; cache?: string } = {
        data: {},
    };
    await fixture(
        async (client, requests) => {
            for (const value of [
                { data: {}, status: 404 },
                { data: {} },
                { data: { playCreation: policy({ replaySupported: false }) } },
                { data: { playCreation: policy({ version: 2 }) } },
                {
                    data: { playCreation: policy() },
                    cache: "public,max-age=60",
                },
                { data: { playCreation: policy() }, status: 202 },
            ]) {
                selected = value;
                const before = requests.length;
                assert.equal(
                    await client.getPlayCreationGrant({ network }),
                    null,
                );
                assert.equal(requests.length - before, 2);
            }
            selected = {
                data: {
                    playCreation: policy({
                        newCreationsEnabled: false,
                        allowedSources: [],
                    }),
                },
            };
            const grant = await client.getPlayCreationGrant({ network });
            assert.ok(grant);
            assert.ok(
                admitPlayCreateGrant(grant, {
                    binding: binding(client),
                    online: true,
                    nowMonotonicMs: performance.now(),
                    intent: { kind: "restore" },
                }),
            );
            assert.equal(
                admitPlayCreateGrant(grant, {
                    binding: binding(client),
                    online: true,
                    nowMonotonicMs: performance.now(),
                    intent: { kind: "new", source: "youtube" },
                }),
                null,
            );
        },
        (request, response) =>
            request.url === "/api/auth/me"
                ? json(response, { id: "owner-a" })
                : json(response, selected.data, selected.status ?? 200, {
                      "Cache-Control": selected.cache ?? "private,no-store",
                  }),
    );
});

test("capability TTL begins at response headers and includes delayed body consumption", async (context) => {
    let now = 100;
    let featureHeadersReturned = false;
    const observed = deferred<void>();
    let delayed: ServerResponse | undefined;
    const nativeFetch = globalThis.fetch;
    context.mock.method(
        globalThis,
        "fetch",
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const response = await nativeFetch(input, init);
            if (String(input).endsWith("/api/system/features"))
                featureHeadersReturned = true;
            return response;
        },
    );
    context.mock.method(performance, "now", () => {
        if (featureHeadersReturned) observed.resolve();
        return now;
    });
    await fixture(
        async (client) => {
            const outer = new AbortController();
            const pending = client.getPlayCreationGrant({
                network,
                signal: outer.signal,
            });
            const settled = pending.catch((error: unknown) => error);
            try {
                await bounded(observed.promise);
                now = 1100;
                assert.ok(delayed);
                delayed.end(
                    JSON.stringify({
                        playCreation: policy({ capabilityTtlSeconds: 1 }),
                    }),
                );
                assert.equal(await bounded(pending), null);
            } finally {
                outer.abort();
                delayed?.end();
                await settled;
            }
        },
        (request, response) => {
            if (request.url === "/api/auth/me")
                json(response, { id: "owner-a" });
            else {
                delayed = response;
                response.writeHead(200, {
                    "Content-Type": "application/json",
                    "Cache-Control": "private,no-store",
                });
                response.flushHeaders();
            }
        },
    );
});

test("late identity and feature responses cannot bind across logout, same-user relogin, nonce revocation, network cycles or abort", async () => {
    for (const phase of ["/api/auth/me", "/api/system/features"]) {
        for (const change of [
            "logout",
            "relogin",
            "nonce",
            "network",
            "offline",
            "abort",
        ]) {
            const arrived = deferred<ServerResponse>();
            let online = true,
                generation = 3;
            const outer = new AbortController();
            await fixture(
                async (client, requests) => {
                    const pending = client.getPlayCreationGrant({
                        network: {
                            isOnline: () => online,
                            getGeneration: () => generation,
                        },
                        signal: outer.signal,
                    });
                    const settled = pending.catch((error: unknown) => error);
                    try {
                        const response = await bounded(arrived.promise);
                        if (change === "logout") client.clearToken();
                        else if (change === "relogin")
                            client.setToken(
                                "replacement-same-owner",
                                "replacement-refresh",
                            );
                        else if (change === "nonce")
                            storage.removeItem(PLAY_CREATE_LOGIN_FENCE_KEY);
                        else if (change === "network") generation++;
                        else if (change === "offline") online = false;
                        else outer.abort();
                        json(
                            response,
                            phase === "/api/auth/me"
                                ? { id: "owner-a" }
                                : { playCreation: policy() },
                        );
                        assert.equal(
                            await bounded(pending),
                            null,
                            `${phase} ${change}`,
                        );
                        assert.equal(
                            requests.length,
                            phase === "/api/auth/me" ? 1 : 2,
                        );
                    } finally {
                        outer.abort();
                        await settled;
                    }
                },
                (request, response) =>
                    request.url === phase
                        ? arrived.resolve(response)
                        : json(response, { id: "owner-a" }),
            );
        }
    }
});

test("grant reads honor cancellation before HTTP and release the original signal after options replacement", async () => {
    await fixture(
        async (client, requests) => {
            const outer = new AbortController();
            outer.abort();
            assert.equal(
                await client.getPlayCreationGrant({
                    network,
                    signal: outer.signal,
                }),
                null,
            );
            assert.equal(
                await client.getPlayCreationGrant({
                    network: { ...network, isOnline: () => false },
                }),
                null,
            );
            assert.equal(requests.length, 0);
        },
        (_request, response) => json(response, {}),
    );
    const arrived = deferred<ServerResponse>();
    await fixture(
        async (client) => {
            const original = new AbortController();
            const options = { network, signal: original.signal };
            const pending = client.getPlayCreationGrant(options);
            const settled = pending.catch((error: unknown) => error);
            try {
                const response = await bounded(arrived.promise);
                options.signal = new AbortController().signal;
                json(response, { playCreation: policy() });
                assert.ok(await pending);
                assert.equal(
                    getEventListeners(original.signal, "abort").length,
                    0,
                );
            } finally {
                original.abort();
                await settled;
            }
        },
        (request, response) =>
            request.url === "/api/auth/me"
                ? json(response, { id: "owner-a" })
                : arrived.resolve(response),
    );
});

test("keyed create preserves exact native recording identity and rejects nonfrozen, mismatched or oversized DTOs before HTTP", async (context) => {
    const nativeFetch = globalThis.fetch;
    context.mock.method(
        globalThis,
        "fetch",
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            assert.equal(init?.cache, "no-store");
            assert.ok(init?.signal);
            return nativeFetch(input, init);
        },
    );
    await fixture(
        async (client, requests) => {
            const payload: PlayCreatePayload = Object.freeze({
                source: "vk",
                wireJson:
                    '{"musicSourceRecording":{"provider":"vk","id":"-20000000000000000000_12345678901234567890","title":"Native","artists":["Artist"],"duration":120,"contentVersion":"unknown","preview":false}}',
            });
            const result = await client.createPlayIdempotent(key, payload, {
                binding: binding(client),
            });
            assert.equal(result.id, "play-id");
            assert.ok(Object.isFrozen(result));
            assert.deepEqual(JSON.parse(requests[0].body), {
                clientPlaybackId: key,
                musicSourceRecording: {
                    provider: "vk",
                    id: "-20000000000000000000_12345678901234567890",
                    title: "Native",
                    artists: ["Artist"],
                    duration: 120,
                    contentVersion: "unknown",
                    preview: false,
                },
            });
            for (const invalid of [
                { ...youtube },
                Object.freeze({ ...youtube, source: "yandex" as const }),
                Object.freeze({
                    source: "youtube" as const,
                    wireJson:
                        '{"youtubeVideoId":"x","title":"x","artist":"a","album":"a","duration":1,"token":"secret"}',
                }),
                Object.freeze({
                    source: "youtube" as const,
                    wireJson: "x".repeat(65_537),
                }),
                Object.freeze({
                    source: "youtube" as const,
                    wireJson:
                        '{"youtubeVideoId":" padded ","title":"x","artist":"a","album":"a","duration":1}',
                }),
            ])
                await assert.rejects(
                    client.createPlayIdempotent(key, invalid, {
                        binding: binding(client),
                    }),
                );
            await assert.rejects(
                client.createPlayIdempotent("invalid-key", youtube, {
                    binding: binding(client),
                }),
            );
            assert.equal(requests.length, 1);
        },
        (_request, response) => json(response, ack(), 201),
    );
});

test("one AUTH_REQUIRED refresh replays the identical frozen create body and preserves the logical login", async () => {
    let posts = 0;
    await fixture(
        async (client, requests) => {
            const captured = binding(client);
            const result = await client.createPlayIdempotent(key, youtube, {
                binding: captured,
            });
            assert.equal(result.id, "play-id");
            assert.equal(client.getToken(), "refreshed-access");
            assert.deepEqual(binding(client), captured);
            const writes = requests.filter(
                (row) => row.url === "/api/plays/idempotent",
            );
            assert.equal(writes.length, 2);
            assert.equal(writes[0].body, writes[1].body);
            assert.deepEqual(JSON.parse(writes[0].body), {
                clientPlaybackId: key,
                youtubeVideoId: "exact-video",
                title: "Track",
                artist: "Artist",
                album: "Album",
                duration: 120,
            });
            assert.deepEqual(
                writes.map((row) => row.authorization),
                ["Bearer fixture-access", "Bearer refreshed-access"],
            );
            assert.equal(
                requests.filter((row) => row.url === "/api/auth/refresh")
                    .length,
                1,
            );
        },
        (request, response) => {
            if (request.url === "/api/auth/refresh")
                json(response, { token: "refreshed-access" });
            else if (++posts === 1)
                json(
                    response,
                    { error: "Authentication needed", code: "AUTH_REQUIRED" },
                    401,
                );
            else json(response, ack());
        },
    );
});

test("a second AUTH_REQUIRED response stops after two create POSTs without another refresh or fallback", async () => {
    await fixture(
        async (client, requests) => {
            await assert.rejects(
                client.createPlayIdempotent(key, youtube, {
                    binding: binding(client),
                }),
                { status: 401 },
            );
            assert.equal(
                requests.filter((row) => row.url === "/api/plays/idempotent")
                    .length,
                2,
            );
            assert.equal(
                requests.filter((row) => row.url === "/api/auth/refresh")
                    .length,
                1,
            );
            assert.equal(requests.length, 3);
        },
        (request, response) =>
            json(
                response,
                request.url === "/api/auth/refresh"
                    ? { token: "refreshed-access" }
                    : { error: "Authentication needed", code: "AUTH_REQUIRED" },
                request.url === "/api/auth/refresh" ? 200 : 401,
            ),
    );
});

test("malformed creation acknowledgements and a lost connection stay unknown without any automatic retry", async () => {
    let mode = "shape";
    await fixture(
        async (client, requests) => {
            for (const selected of [
                "shape",
                "key",
                "expiry",
                "json",
                "connection",
            ]) {
                mode = selected;
                const before = requests.length;
                await assert.rejects(
                    client.createPlayIdempotent(key, youtube, {
                        binding: binding(client),
                    }),
                    (error: unknown) => {
                        assert.ok(error instanceof Error);
                        assert.equal(
                            error.message.includes("secret-body"),
                            false,
                        );
                        return true;
                    },
                );
                assert.equal(requests.length - before, 1, selected);
            }
        },
        (_request, response, raw) => {
            if (mode === "connection") raw.socket.destroy();
            else if (mode === "json") {
                response.writeHead(200);
                response.end('secret-body{"');
            } else if (mode === "key")
                json(
                    response,
                    ack({
                        playCreation: {
                            ...ack().playCreation,
                            clientPlaybackId: "wrong-key",
                        },
                    }),
                );
            else if (mode === "expiry")
                json(
                    response,
                    ack({
                        playCreation: {
                            ...ack().playCreation,
                            replayExpiresAt: "2026-01-01T00:00:00Z",
                        },
                    }),
                );
            else json(response, { ...ack(), extra: "secret-body" });
        },
    );
});

test("create rejects stale auth bindings before HTTP and discards a response after generation or nonce replacement", async () => {
    for (const change of ["generation", "nonce"]) {
        const arrived = deferred<ServerResponse>();
        await fixture(
            async (client, requests) => {
                const captured = binding(client);
                await assert.rejects(
                    client.createPlayIdempotent(key, youtube, {
                        binding: {
                            ...captured,
                            authGeneration: captured.authGeneration - 1,
                        },
                    }),
                    SupersededAuthSessionError,
                );
                assert.equal(requests.length, 0);
                const pending = client.createPlayIdempotent(key, youtube, {
                    binding: captured,
                });
                const settled = pending.catch((error: unknown) => error);
                try {
                    const response = await bounded(arrived.promise);
                    if (change === "generation")
                        client.setToken(
                            "replacement-access",
                            "replacement-refresh",
                        );
                    else storage.removeItem(PLAY_CREATE_LOGIN_FENCE_KEY);
                    json(response, ack());
                    await assert.rejects(pending, SupersededAuthSessionError);
                    assert.equal(requests.length, 1);
                } finally {
                    await settled;
                }
            },
            (_request, response) => arrived.resolve(response),
        );
    }
});

test("known engagement PATCH uses the same auth fence and bounded refresh, validates its ACK and never retries a malformed result", async () => {
    let patches = 0,
        malformed = false;
    await fixture(
        async (client, requests) => {
            const captured = binding(client);
            assert.deepEqual(
                await client.updatePlayEngagementIdempotent(
                    "known/id",
                    engagement,
                    { binding: captured },
                ),
                { success: true, stale: false },
            );
            const writes = requests.filter((row) => row.method === "PATCH");
            assert.equal(writes.length, 2);
            assert.equal(writes[0].url, "/api/plays/known%2Fid/engagement");
            assert.equal(writes[0].body, writes[1].body);
            assert.deepEqual(JSON.parse(writes[0].body), engagement);
            malformed = true;
            await assert.rejects(
                client.updatePlayEngagementIdempotent("known/id", engagement, {
                    binding: captured,
                }),
            );
            assert.equal(
                requests.filter((row) => row.method === "PATCH").length,
                3,
            );
            client.setToken("replacement-access", "replacement-refresh");
            await assert.rejects(
                client.updatePlayEngagementIdempotent("known/id", engagement, {
                    binding: captured,
                }),
                SupersededAuthSessionError,
            );
            assert.equal(
                requests.filter((row) => row.method === "PATCH").length,
                3,
            );
        },
        (request, response) => {
            if (request.url === "/api/auth/refresh")
                json(response, { token: "refreshed-access" });
            else if (++patches === 1)
                json(
                    response,
                    { error: "Authentication needed", code: "AUTH_REQUIRED" },
                    401,
                );
            else
                json(
                    response,
                    malformed
                        ? { success: true, unexpected: true }
                        : { success: true, stale: false },
                );
        },
    );
});

test("HTTP 503 preserves safe Retry-After receipt metadata unchanged without replaying either mutation", async () => {
    await fixture(
        async (client, requests) => {
            const options = { binding: binding(client) };
            for (const operation of [
                () => client.createPlayIdempotent(key, youtube, options),
                () =>
                    client.updatePlayEngagementIdempotent(
                        "known-id",
                        engagement,
                        options,
                    ),
            ]) {
                await assert.rejects(operation(), (error: unknown) => {
                    assert.ok(
                        error instanceof Error &&
                            "status" in error &&
                            "retryAfterMs" in error &&
                            "responseReceipt" in error,
                    );
                    assert.equal(error.status, 503);
                    assert.equal(error.retryAfterMs, 37000);
                    assert.deepEqual(
                        Object.keys(error.responseReceipt as object).sort(),
                        [
                            "status",
                            "receivedMonotonicMs",
                            "privateNoStore",
                            "retryAfterMs",
                        ].sort(),
                    );
                    assert.ok(Object.isFrozen(error.responseReceipt));
                    assert.equal(
                        JSON.stringify(error).includes("must-not-escape"),
                        false,
                    );
                    return true;
                });
            }
            assert.equal(requests.length, 2);
        },
        (_request, response) =>
            json(response, { error: "Temporarily unavailable" }, 503, {
                "Retry-After": "37",
                "X-Private-Token": "must-not-escape",
            }),
    );
});
