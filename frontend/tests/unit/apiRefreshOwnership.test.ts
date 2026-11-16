import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import test, { after, beforeEach } from "node:test";
import { ApiClientCore, SupersededAuthSessionError } from "../../lib/api/core";
import { WithPlays } from "../../lib/api/plays";
import { PLAY_CREATE_LOGIN_FENCE_KEY } from "../../lib/playCreateLoginFence";
import type { PlayCreateBinding } from "../../lib/playCreateJournal";

const originals = new Map(
    ["window", "document", "localStorage"].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
);
const values = new Map<string, string>();
let denyMetadata = false;
const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
        if (denyMetadata && key === PLAY_CREATE_LOGIN_FENCE_KEY)
            throw new Error("Private metadata unavailable");
        values.set(key, value);
    },
    removeItem: (key: string) => {
        values.delete(key);
    },
};
const fakeDocument = Object.assign(new EventTarget(), {
    cookie: "",
    visibilityState: "visible",
});
const fakeWindow = Object.assign(new EventTarget(), { localStorage: storage });
for (const [name, value] of [
    ["window", fakeWindow],
    ["document", fakeDocument],
    ["localStorage", storage],
] as const)
    Object.defineProperty(globalThis, name, { value, configurable: true });
beforeEach(() => {
    values.clear();
    denyMetadata = false;
    fakeDocument.cookie = "";
});
after(() => {
    for (const [name, descriptor] of originals)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
});
class Client extends WithPlays(ApiClientCore) {}
const key = "p1.7.mjt91xc0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const payload = Object.freeze({
    source: "youtube" as const,
    wireJson:
        '{"youtubeVideoId":"exact-video","title":"Track","artist":"Artist","album":"Album","duration":120}',
});
function binding(client: Client): PlayCreateBinding {
    const loginNonce = client.getPlayCreateLoginNonce();
    assert.ok(loginNonce);
    return {
        ownerId: "old-owner",
        loginNonce,
        authGeneration: client.getSessionGeneration(),
        networkGeneration: 3,
    };
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
                    () => reject(new Error("Refresh fixture did not settle")),
                    3000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
function json(response: ServerResponse, body: unknown, status = 200) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}
function ack(response: ServerResponse) {
    json(response, {
        id: "old-play",
        playCreation: {
            version: 1,
            clientPlaybackId: key,
            disposition: "created",
            replayExpiresAt: "2026-01-01T00:00:00.000Z",
        },
    });
}
async function fixture(
    run: (
        client: Client,
        base: string,
        refresh: Promise<ServerResponse>,
        counts: {
            posts: number;
            patches: number;
            reads: number;
            refreshes: number;
        },
    ) => Promise<void>,
) {
    const arrived = deferred<ServerResponse>(),
        counts = { posts: 0, patches: 0, reads: 0, refreshes: 0 };
    const server = createServer((request, response) => {
        request.resume();
        if (request.url === "/api/auth/refresh") {
            counts.refreshes++;
            arrived.resolve(response);
        } else if (request.url === "/api/plays/idempotent") {
            counts.posts++;
            if (counts.posts === 1)
                json(
                    response,
                    { error: "Authentication needed", code: "AUTH_REQUIRED" },
                    401,
                );
            else ack(response);
        } else if (request.method === "PATCH") {
            counts.patches++;
            if (counts.patches === 1)
                json(
                    response,
                    { error: "Authentication needed", code: "AUTH_REQUIRED" },
                    401,
                );
            else json(response, { success: true });
        } else {
            counts.reads++;
            if (counts.reads === 1)
                json(
                    response,
                    { error: "Authentication needed", code: "AUTH_REQUIRED" },
                    401,
                );
            else json(response, { ok: true });
        }
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`,
        client = new Client(base);
    client.setToken("old-access", "old-refresh");
    try {
        await run(client, base, arrived.promise, counts);
    } finally {
        client.clearToken();
        const closed = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        await closed;
    }
}

test("late refresh cannot overwrite another tab's credentials, cookie or repeated-login publication", async () => {
    for (const mode of ["successful", "rejected", "same-credentials"]) {
        await fixture(async (client, base, refresh, counts) => {
            const captured = binding(client),
                pending = client.createPlayIdempotent(key, payload, {
                    binding: captured,
                });
            const settled = pending.catch((error) => error);
            try {
                const response = await bounded(refresh);
                const replacement = new Client(base);
                replacement.setToken(
                    mode === "same-credentials" ? "old-access" : "new-access",
                    mode === "same-credentials" ? "old-refresh" : "new-refresh",
                );
                const expectedAccess = storage.getItem("auth_token"),
                    expectedRefresh = storage.getItem("refresh_token"),
                    expectedCookie = fakeDocument.cookie;
                assert.equal(
                    client.getSessionGeneration(),
                    captured.authGeneration,
                    "other tab has not delivered its event",
                );
                json(
                    response,
                    mode === "rejected"
                        ? { error: "Invalid refresh" }
                        : {
                              token: "late-old-access",
                              refreshToken: "late-old-refresh",
                          },
                    mode === "rejected" ? 401 : 200,
                );
                await assert.rejects(pending, SupersededAuthSessionError);
                assert.equal(
                    storage.getItem("auth_token"),
                    expectedAccess,
                    mode,
                );
                assert.equal(
                    storage.getItem("refresh_token"),
                    expectedRefresh,
                    mode,
                );
                assert.equal(fakeDocument.cookie, expectedCookie, mode);
                assert.equal(
                    counts.posts,
                    1,
                    "no new old-owner POST after replacement",
                );
                assert.ok(replacement.getPlayCreateLoginNonce());
                replacement.clearToken();
            } finally {
                await settled;
            }
        });
    }
});

test("credential replacement during refresh JSON consumption is checked before shared writes", async (context) => {
    const reading = deferred<void>(),
        nativeFetch = globalThis.fetch;
    context.mock.method(
        globalThis,
        "fetch",
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const response = await nativeFetch(input, init);
            if (String(input).endsWith("/api/auth/refresh")) {
                const consume = response.json.bind(response);
                response.json = () => {
                    reading.resolve();
                    return consume();
                };
            }
            return response;
        },
    );
    await fixture(async (client, base, refresh, counts) => {
        const pending = client.createPlayIdempotent(key, payload, {
                binding: binding(client),
            }),
            settled = pending.catch((error) => error);
        try {
            const response = await bounded(refresh);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.write("{");
            await bounded(reading.promise);
            const replacement = new Client(base);
            replacement.setToken("new-access", "new-refresh");
            const cookie = fakeDocument.cookie;
            response.end(
                '"token":"late-old-access","refreshToken":"late-old-refresh"}',
            );
            await assert.rejects(pending, SupersededAuthSessionError);
            assert.equal(storage.getItem("auth_token"), "new-access");
            assert.equal(storage.getItem("refresh_token"), "new-refresh");
            assert.equal(fakeDocument.cookie, cookie);
            assert.equal(counts.posts, 1);
            replacement.clearToken();
        } finally {
            await settled;
        }
    });
});

test("journal nonce withdrawal stops the auth replay while ordinary same-login credentials can rotate", async () => {
    await fixture(async (client, _base, refresh, counts) => {
        const pending = client.createPlayIdempotent(key, payload, {
                binding: binding(client),
            }),
            settled = pending.catch((error) => error);
        try {
            const response = await bounded(refresh);
            storage.removeItem(PLAY_CREATE_LOGIN_FENCE_KEY);
            json(response, {
                token: "same-owner-new-access",
                refreshToken: "same-owner-new-refresh",
            });
            await assert.rejects(pending, SupersededAuthSessionError);
            assert.equal(counts.posts, 1);
            assert.equal(client.getToken(), "same-owner-new-access");
            assert.equal(client.getPlayCreateLoginNonce(), null);
        } finally {
            await settled;
        }
    });
});

test("ordinary authentication still refreshes when private journal metadata is unavailable", async () => {
    denyMetadata = true;
    await fixture(async (client, _base, refresh, counts) => {
        assert.equal(client.getPlayCreateLoginNonce(), null);
        const pending = client.request("/ordinary"),
            settled = pending.catch((error) => error);
        try {
            json(await bounded(refresh), {
                token: "ordinary-new-access",
                refreshToken: "ordinary-new-refresh",
            });
            assert.deepEqual(await pending, { ok: true });
            assert.equal(counts.reads, 2);
            assert.equal(counts.refreshes, 1);
            assert.equal(client.getToken(), "ordinary-new-access");
            assert.equal(client.getPlayCreateLoginNonce(), null);
        } finally {
            await settled;
        }
    });
});

test("known engagement cannot send a second PATCH after journal nonce withdrawal during refresh", async () => {
    await fixture(async (client, _base, refresh, counts) => {
        const pending = client.updatePlayEngagementIdempotent(
                "known-play",
                {
                    listenedSeconds: 60,
                    completionRatio: 0.5,
                    outcome: "meaningful",
                },
                { binding: binding(client) },
            ),
            settled = pending.catch((error) => error);
        try {
            const response = await bounded(refresh);
            storage.removeItem(PLAY_CREATE_LOGIN_FENCE_KEY);
            json(response, {
                token: "same-owner-new-access",
                refreshToken: "same-owner-new-refresh",
            });
            await assert.rejects(pending, SupersededAuthSessionError);
            assert.equal(counts.patches, 1);
        } finally {
            await settled;
        }
    });
});
