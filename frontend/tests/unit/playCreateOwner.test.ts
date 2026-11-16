import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ApiClientCore } from "../../lib/api/core";
import { writeCachedAuthUser } from "../../lib/auth-offline-session";
import { PLAY_CREATE_LOGIN_FENCE_KEY } from "../../lib/playCreateLoginFence";
import { preparePlayCreateOwner } from "../../lib/playCreateOwner";

GlobalRegistrator.register();
class Client extends ApiClientCore {}
beforeEach(() => localStorage.clear());
after(() => GlobalRegistrator.unregister());

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture() {
    const state = {
        authGeneration: 2,
        loginNonce: "A".repeat(32) as string | null,
        networkGeneration: 3,
        online: true,
        initCalls: 0,
        ownerCalls: 0,
        signals: [] as AbortSignal[],
    };
    let initialize = async (): Promise<string | null> => "access";
    let read = async (_signal: AbortSignal): Promise<unknown> => ({
        id: "owner-a",
    });
    const dependencies: Parameters<typeof preparePlayCreateOwner>[0] = {
        api: {
            initToken: async () => {
                state.initCalls++;
                return initialize();
            },
            getSessionGeneration: () => state.authGeneration,
            getPlayCreateLoginNonce: () => state.loginNonce,
        },
        readFreshOwner: async (signal) => {
            state.ownerCalls++;
            state.signals.push(signal);
            return read(signal);
        },
        network: {
            isOnline: () => state.online,
            getGeneration: () => state.networkGeneration,
        },
    };
    return {
        state,
        dependencies,
        initialize: (next: typeof initialize) => (initialize = next),
        read: (next: typeof read) => (read = next),
    };
}

test("fresh owner binding is a frozen exact snapshot with a private explicit signal", async () => {
    const { dependencies, state, read } = fixture();
    const response = { id: "o".repeat(128), username: "listener" };
    read(async () => response);
    const binding = await preparePlayCreateOwner(dependencies);
    assert.deepEqual(binding, {
        ownerId: "o".repeat(128),
        loginNonce: "A".repeat(32),
        authGeneration: 2,
        networkGeneration: 3,
    });
    assert.ok(Object.isFrozen(binding));
    response.id = "changed-owner";
    state.loginNonce = "B".repeat(32);
    assert.equal(binding?.ownerId, "o".repeat(128));
    assert.equal(binding?.loginNonce, "A".repeat(32));
    assert.equal(state.initCalls, 0);
    assert.equal(state.ownerCalls, 1);
    assert.ok(state.signals[0] instanceof AbortSignal);
});

test("a real API same-login token refresh preserves the captured login binding", async (context) => {
    const client = new Client("http://soundspan.test");
    client.setToken("access-old", "refresh-old");
    const expectedNonce = client.getPlayCreateLoginNonce();
    assert.match(expectedNonce ?? "", /^[A-Za-z0-9_-]{32}$/);
    const expectedGeneration = client.getSessionGeneration();
    let requests = 0;
    context.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) => {
            requests++;
            if (String(input).endsWith("/api/auth/refresh"))
                return Response.json({ token: "access-new" });
            assert.equal(init?.cache, "no-store");
            assert.ok(init?.signal);
            return new Headers(init?.headers).get("Authorization") ===
                "Bearer access-new"
                ? Response.json({ id: "owner-a" })
                : Response.json(
                      { error: "Authentication needed", code: "AUTH_REQUIRED" },
                      { status: 401 },
                  );
        },
    );
    try {
        const binding = await preparePlayCreateOwner({
            api: client,
            readFreshOwner: (signal) =>
                client.request("/auth/me", {
                    signal,
                    cache: "no-store",
                    retryOnTimeout: false,
                }),
            network: { isOnline: () => true, getGeneration: () => 3 },
        });
        assert.match(binding?.loginNonce ?? "", /^[A-Za-z0-9_-]{32}$/);
        assert.deepEqual(binding, {
            ownerId: "owner-a",
            loginNonce: expectedNonce,
            authGeneration: expectedGeneration,
            networkGeneration: 3,
        });
        assert.equal(client.getToken(), "access-new");
        assert.equal(requests, 3);
    } finally {
        client.clearToken();
    }
});

test("P2 prepare/restore interleaving recovers with exactly one explicit real API init before fresh identity", async (context) => {
    const client = new Client("http://soundspan.test");
    client.setToken("access-a", "refresh-a");
    let otherTab: Client | undefined;
    let interleave = true;
    const setItem = localStorage.setItem.bind(localStorage);
    context.mock.method(
        localStorage,
        "setItem",
        (key: string, value: string) => {
            setItem(key, value);
            if (interleave && key === PLAY_CREATE_LOGIN_FENCE_KEY) {
                interleave = false;
                otherTab = new Client("http://soundspan.test");
            }
        },
    );
    client.setToken("access-b", "refresh-b");
    assert.equal(client.getPlayCreateLoginNonce(), null);
    assert.equal(otherTab?.getPlayCreateLoginNonce(), null);
    writeCachedAuthUser({ id: "cached-a", username: "cached", role: "user" });
    const initialize = client.initToken.bind(client);
    let initCalls = 0;
    context.mock.method(client, "initToken", async () => {
        initCalls++;
        return initialize();
    });
    let ownerCalls = 0;
    context.mock.method(
        globalThis,
        "fetch",
        async (_input: string | URL | Request, init?: RequestInit) => {
            ownerCalls++;
            assert.ok(client.getPlayCreateLoginNonce());
            assert.equal(init?.cache, "no-store");
            assert.ok(init?.signal);
            assert.equal(
                new Headers(init?.headers).get("Authorization"),
                "Bearer access-b",
            );
            return Response.json({ id: "owner-b" });
        },
    );
    try {
        const binding = await preparePlayCreateOwner({
            api: client,
            readFreshOwner: (signal) =>
                client.request("/auth/me", {
                    signal,
                    cache: "no-store",
                    retryOnTimeout: false,
                }),
            network: { isOnline: () => true, getGeneration: () => 3 },
        });
        assert.match(binding?.loginNonce ?? "", /^[A-Za-z0-9_-]{32}$/);
        assert.deepEqual(binding, {
            ownerId: "owner-b",
            loginNonce: client.getPlayCreateLoginNonce(),
            authGeneration: 2,
            networkGeneration: 3,
        });
        assert.equal(initCalls, 1);
        assert.equal(ownerCalls, 1);
    } finally {
        client.clearToken();
        otherTab?.clearToken();
    }
});

test("denied real API metadata remains null after one init and never reads an owner", async (context) => {
    const client = new Client("http://soundspan.test");
    const setItem = localStorage.setItem.bind(localStorage);
    context.mock.method(
        localStorage,
        "setItem",
        (key: string, value: string) => {
            if (key === PLAY_CREATE_LOGIN_FENCE_KEY)
                throw new Error("Private metadata denied");
            setItem(key, value);
        },
    );
    client.setToken("access", "refresh");
    assert.equal(client.getPlayCreateLoginNonce(), null);
    const initialize = client.initToken.bind(client);
    let initCalls = 0;
    context.mock.method(client, "initToken", async () => {
        initCalls++;
        return initialize();
    });
    let ownerCalls = 0;
    try {
        const result = await preparePlayCreateOwner({
            api: client,
            readFreshOwner: async () => {
                ownerCalls++;
                return { id: "owner-a" };
            },
            network: { isOnline: () => true, getGeneration: () => 3 },
        });
        assert.equal(result, null);
        assert.equal(initCalls, 1);
        assert.equal(ownerCalls, 0);
        assert.equal(client.getToken(), "access");
    } finally {
        client.clearToken();
    }
});

test("a late identity cannot bind after logout, same-user relogin or nonce revocation", async () => {
    for (const change of ["logout", "relogin", "nonce", "auth-only"] as const) {
        const { dependencies, state, read } = fixture();
        const response = deferred<unknown>();
        read(() => response.promise);
        const pending = preparePlayCreateOwner(dependencies);
        if (change !== "nonce") state.authGeneration++;
        if (change !== "auth-only")
            state.loginNonce = change === "logout" ? null : "B".repeat(32);
        response.resolve({ id: change === "logout" ? "owner-a" : "owner-b" });
        assert.equal(await pending, null, change);
        assert.equal(state.ownerCalls, 1);
        assert.equal(state.initCalls, 0);
    }
});

test("offline and an offline-to-online cycle revoke a pending identity snapshot", async () => {
    for (const finalOnline of [false, true]) {
        const { dependencies, state, read } = fixture();
        const response = deferred<unknown>();
        read(() => response.promise);
        const pending = preparePlayCreateOwner(dependencies);
        state.online = false;
        if (finalOnline) state.networkGeneration++;
        state.online = finalOnline;
        response.resolve({ id: "owner-a" });
        assert.equal(await pending, null);
    }
});

test("pre-aborted and initially offline calls perform no init or identity read", async () => {
    for (const offline of [false, true]) {
        const { dependencies, state } = fixture();
        const outer = new AbortController();
        state.loginNonce = null;
        if (offline) state.online = false;
        else outer.abort();
        assert.equal(
            await preparePlayCreateOwner(dependencies, {
                signal: outer.signal,
            }),
            null,
        );
        assert.equal(state.initCalls, 0);
        assert.equal(state.ownerCalls, 0);
    }
});

test("outer cancellation forwards to the private signal and ignores a late owner", async () => {
    const { dependencies, state, read } = fixture();
    const outer = new AbortController();
    const response = deferred<unknown>();
    read(() => response.promise);
    const pending = preparePlayCreateOwner(dependencies, {
        signal: outer.signal,
    });
    assert.notEqual(state.signals[0], outer.signal);
    assert.equal(state.signals[0].aborted, false);
    outer.abort("owner read cancelled");
    assert.equal(state.signals[0].aborted, true);
    assert.equal(state.signals[0].reason, "owner read cancelled");
    response.resolve({ id: "owner-a" });
    assert.equal(await pending, null);

    const completed = fixture();
    const laterAbort = new AbortController();
    assert.ok(
        await preparePlayCreateOwner(completed.dependencies, {
            signal: laterAbort.signal,
        }),
    );
    laterAbort.abort();
    assert.equal(
        completed.state.signals[0].aborted,
        false,
        "completed reads must detach the outer abort listener",
    );
});

test("identity and init failures close without retry or legacy fallback", async () => {
    for (const failingOperation of ["owner", "init"] as const) {
        const { dependencies, state, initialize, read } = fixture();
        if (failingOperation === "init") {
            state.loginNonce = null;
            initialize(async () => {
                throw new Error("No credential storage");
            });
        } else
            read(async () => {
                throw new TypeError("Network unavailable");
            });
        assert.equal(await preparePlayCreateOwner(dependencies), null);
        assert.equal(state.initCalls, failingOperation === "init" ? 1 : 0);
        assert.equal(state.ownerCalls, failingOperation === "owner" ? 1 : 0);
    }

    const failed = fixture();
    const laterAbort = new AbortController();
    failed.read(async () => {
        throw new Error("Unavailable identity");
    });
    assert.equal(
        await preparePlayCreateOwner(failed.dependencies, {
            signal: laterAbort.signal,
        }),
        null,
    );
    laterAbort.abort();
    assert.equal(failed.state.signals[0].aborted, false);
});

test("owner validation requires a bounded own data id and never invokes its getter", async () => {
    let getterCalls = 0;
    const getter = Object.defineProperty({}, "id", {
        enumerable: true,
        get: () => {
            getterCalls++;
            return "owner-a";
        },
    });
    const invalid = [
        null,
        [],
        { id: "" },
        { id: "   " },
        { id: "o".repeat(129) },
        { id: 1 },
        Object.create({ id: "owner-a" }),
        getter,
        new Proxy(
            {},
            {
                getOwnPropertyDescriptor: () => {
                    throw new Error("Unavailable descriptor");
                },
            },
        ),
    ];
    for (const value of invalid) {
        const { dependencies, read } = fixture();
        read(async () => value);
        assert.equal(await preparePlayCreateOwner(dependencies), null);
    }
    assert.equal(getterCalls, 0);
});

test("init recovery cannot adopt a replacement generation, network cycle or cancelled login", async () => {
    for (const change of ["auth", "network", "abort"] as const) {
        const { dependencies, state, initialize } = fixture();
        state.loginNonce = null;
        const initialized = deferred<string | null>();
        initialize(() => initialized.promise);
        const outer = new AbortController();
        const pending = preparePlayCreateOwner(dependencies, {
            signal: outer.signal,
        });
        assert.equal(state.initCalls, 1);
        if (change === "auth") state.authGeneration++;
        else if (change === "network") state.networkGeneration++;
        else outer.abort();
        state.loginNonce = "B".repeat(32);
        initialized.resolve("access-new");
        assert.equal(await pending, null, change);
        assert.equal(state.ownerCalls, 0);
        assert.equal(state.initCalls, 1);
    }
});

test("authoritative dependency replacement during identity read is checked before binding", async () => {
    for (const replacement of ["api", "network"] as const) {
        const { dependencies, read } = fixture();
        const response = deferred<unknown>();
        read(() => response.promise);
        const pending = preparePlayCreateOwner(dependencies);
        if (replacement === "api")
            dependencies.api = {
                ...dependencies.api,
                getSessionGeneration: () => 8,
            };
        else
            dependencies.network = {
                isOnline: () => true,
                getGeneration: () => 9,
            };
        response.resolve({ id: "owner-b" });
        assert.equal(await pending, null, replacement);
    }
});
