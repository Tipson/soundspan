import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ApiClientCore } from "../../lib/api/core";
import { AUTH_SESSION_CHANGE_KEY } from "../../lib/auth-offline-session";
import { activateUserPlaybackStorage } from "../../lib/userPlaybackStorage";
import {
    PLAY_CREATE_LOGIN_FENCE_KEY,
    preparePlayCreateLoginFence,
    readPlayCreateLoginFence,
    restorePlayCreateLoginFence,
    retirePlayCreateLoginFence,
} from "../../lib/playCreateLoginFence";

GlobalRegistrator.register();
class Client extends ApiClientCore {}
beforeEach(() => localStorage.clear());
after(() => GlobalRegistrator.unregister());

function nonce(client: Client): string | null {
    const getter = Reflect.get(client, "getPlayCreateLoginNonce");
    assert.equal(
        typeof getter,
        "function",
        "the API client must expose its current durable login fence",
    );
    return getter.call(client);
}

test("public credential replacement commits a different nonce before publishing auth changes", (context) => {
    const client = new Client("http://soundspan.test");
    const published: (string | null)[] = [];
    const setItem = localStorage.setItem.bind(localStorage);
    context.mock.method(
        localStorage,
        "setItem",
        (key: string, value: string) => {
            if (
                key === AUTH_SESSION_CHANGE_KEY &&
                localStorage.getItem("auth_token")
            ) {
                const prepared = JSON.parse(
                    localStorage.getItem(PLAY_CREATE_LOGIN_FENCE_KEY) ?? "null",
                );
                assert.equal(prepared.nonce, value);
                assert.equal(prepared.publication, value);
            }
            setItem(key, value);
            if (key === AUTH_SESSION_CHANGE_KEY) published.push(nonce(client));
        },
    );
    client.setToken("access-one", "refresh-one");
    const first = nonce(client);
    assert.match(first ?? "", /^[A-Za-z0-9_-]{32}$/);
    client.setToken("access-one", "refresh-two");
    const second = nonce(client);
    assert.match(second ?? "", /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(
        first,
        second,
        "same-user/same-access-token relogin still starts another logical login",
    );
    assert.deepEqual(published, [first, second]);
    client.clearToken();
});

test("a prepared future publication revokes the old fence without adopting an uncommitted login", () => {
    const client = new Client("http://soundspan.test");
    client.setToken("access", "refresh");
    const old = nonce(client);
    const replacement = "X".repeat(32);
    assert.equal(preparePlayCreateLoginFence(replacement), true);
    assert.equal(readPlayCreateLoginFence(), null);
    assert.equal(nonce(client), null);
    assert.notEqual(old, replacement);
    client.clearToken();
});

test("late cleanup cannot remove another login's private metadata", () => {
    const client = new Client("http://soundspan.test");
    client.setToken("access-one", "refresh-one");
    const old = nonce(client);
    client.setToken("access-two", "refresh-two");
    const current = nonce(client);
    retirePlayCreateLoginFence(old);
    assert.equal(readPlayCreateLoginFence(), current);
    assert.equal(nonce(client), current);
    client.clearToken();
});

test("a failed metadata replacement leaves the new credential usable but disables journal admission", (context) => {
    const client = new Client("http://soundspan.test");
    client.setToken("access-one", "refresh-one");
    const old = nonce(client);
    const setItem = localStorage.setItem.bind(localStorage);
    let fail = true;
    context.mock.method(
        localStorage,
        "setItem",
        (key: string, value: string) => {
            if (fail && key === PLAY_CREATE_LOGIN_FENCE_KEY)
                throw new Error("Private metadata unavailable");
            setItem(key, value);
        },
    );
    client.setToken("access-two", "refresh-two");
    assert.equal(client.getToken(), "access-two");
    assert.equal(nonce(client), null);
    assert.equal(
        readPlayCreateLoginFence(),
        null,
        "the new publication must reject the retained old record",
    );
    fail = false;
    const restored = new Client("http://soundspan.test");
    assert.match(nonce(restored) ?? "", /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(nonce(restored), old);
    restored.clearToken();
});

test("future and malformed metadata are not silently replaced during restoration", () => {
    for (const raw of [
        '{"version":2,"nonce":"future"}',
        '{"version":1}',
        "{broken",
    ]) {
        localStorage.setItem(PLAY_CREATE_LOGIN_FENCE_KEY, raw);
        assert.equal(
            restorePlayCreateLoginFence(localStorage, () => "A".repeat(32)),
            null,
        );
        assert.equal(localStorage.getItem(PLAY_CREATE_LOGIN_FENCE_KEY), raw);
        assert.equal(readPlayCreateLoginFence(), null);
    }
});

test("restoration refuses malformed publication and unavailable secure randomness", () => {
    localStorage.setItem(
        AUTH_SESSION_CHANGE_KEY,
        "https://untrusted.invalid/signal",
    );
    assert.equal(
        restorePlayCreateLoginFence(localStorage, () => "A".repeat(32)),
        null,
    );
    assert.equal(localStorage.getItem(PLAY_CREATE_LOGIN_FENCE_KEY), null);
    localStorage.removeItem(AUTH_SESSION_CHANGE_KEY);
    assert.equal(
        restorePlayCreateLoginFence(localStorage, () => null),
        null,
    );
    assert.equal(localStorage.getItem(PLAY_CREATE_LOGIN_FENCE_KEY), null);
});

test("unreadable or unavailable storage never supplies a login fence", () => {
    const unavailable = {
        getItem: () => {
            throw new Error("Storage unavailable");
        },
        setItem: () => {
            throw new Error("Storage unavailable");
        },
        removeItem: () => {
            throw new Error("Storage unavailable");
        },
    };
    assert.equal(restorePlayCreateLoginFence(unavailable), null);
    assert.equal(readPlayCreateLoginFence(unavailable), null);
    assert.equal(
        preparePlayCreateLoginFence("A".repeat(32), unavailable),
        false,
    );
    assert.doesNotThrow(() =>
        retirePlayCreateLoginFence("A".repeat(32), unavailable),
    );
    assert.equal(restorePlayCreateLoginFence(null), null);
});

test("same-login page reload and token reload preserve the durable fence", async () => {
    const first = new Client("http://soundspan.test");
    first.setToken("access", "refresh");
    const expected = nonce(first);
    const reloaded = new Client("http://soundspan.test");
    assert.equal(nonce(reloaded), expected);
    reloaded.reloadTokenFromStorage();
    assert.equal(nonce(reloaded), expected);
    await reloaded.initToken();
    assert.equal(nonce(reloaded), expected);
    reloaded.clearToken();
});

test("fresh credential publication retires the old tab before its storage event is delivered", () => {
    const first = new Client("http://soundspan.test");
    first.setToken("alice", "alice-refresh");
    const oldTab = new Client("http://soundspan.test");
    const old = nonce(oldTab);
    first.setToken("bob", "bob-refresh");
    assert.notEqual(nonce(first), old);
    assert.equal(nonce(oldTab), null);
    oldTab.reloadTokenFromStorage();
    assert.equal(nonce(oldTab), nonce(first));
    first.clearToken();
});

test("logout and cached offline playback cannot restore journal admission", () => {
    const client = new Client("http://soundspan.test");
    client.setToken("access", "refresh");
    const retired = nonce(client);
    client.clearToken();
    assert.equal(nonce(client), null);
    activateUserPlaybackStorage("cached-alice");
    const offline = new Client("http://soundspan.test");
    assert.equal(nonce(offline), null);
    client.setToken("access", "new-refresh");
    assert.notEqual(nonce(client), retired);
    client.clearToken();
});

test("an ordinary successful token refresh keeps the same logical login", async (context) => {
    const client = new Client("http://soundspan.test");
    client.setToken("access-old", "refresh-old");
    const before = nonce(client);
    context.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).endsWith("/api/auth/refresh"))
                return Response.json({
                    token: "access-new",
                    refreshToken: "refresh-new",
                });
            return new Headers(init?.headers).get("Authorization") ===
                "Bearer access-new"
                ? Response.json({ ok: true })
                : Response.json(
                      { error: "Authentication needed", code: "AUTH_REQUIRED" },
                      { status: 401 },
                  );
        },
    );
    assert.deepEqual(await client.request("/system/features"), { ok: true });
    assert.equal(client.getToken(), "access-new");
    assert.equal(nonce(client), before);
    client.clearToken();
});

test("upgrading an existing token creates only a private fence and never publishes an auth reset", () => {
    localStorage.setItem("auth_token", "existing-access");
    const publication = localStorage.getItem(AUTH_SESSION_CHANGE_KEY);
    const client = new Client("http://soundspan.test");
    assert.match(nonce(client) ?? "", /^[A-Za-z0-9_-]{32}$/);
    assert.equal(localStorage.getItem(AUTH_SESSION_CHANGE_KEY), publication);
    assert.equal(client.getToken(), "existing-access");
    client.clearToken();
});
