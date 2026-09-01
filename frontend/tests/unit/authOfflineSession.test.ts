import assert from "node:assert/strict";
import test from "node:test";
import {
    AUTH_SESSION_CHANGE_KEY,
    isAuthSessionChangeStorageEvent,
    publishAuthSessionChange,
    readCachedAuthUser,
    logoutWithMandatoryLocalCleanup,
    shouldRestoreCachedOfflineSession,
    writeCachedAuthUser,
} from "../../lib/auth-offline-session";

test("cross-tab auth notifications are opaque and recognizable without carrying tokens", () => {
    const values = new Map<string, string>();
    const storage = {
        setItem: (key: string, value: string) => values.set(key, value),
    };

    publishAuthSessionChange(storage, () => "opaque-generation-7");

    assert.equal(values.get(AUTH_SESSION_CHANGE_KEY), "opaque-generation-7");
    assert.equal(
        isAuthSessionChangeStorageEvent({ key: AUTH_SESSION_CHANGE_KEY }),
        true,
    );
    assert.equal(isAuthSessionChangeStorageEvent({ key: "auth_token" }), false);
});

test("network loss may restore the cached user while an explicit auth rejection never does", () => {
    const cachedUser = {
        id: "user-1",
        username: "listener",
        role: "user",
    };

    assert.equal(
        shouldRestoreCachedOfflineSession({
            error: new TypeError("Failed to fetch"),
            online: false,
            hasAccessToken: true,
            cachedUser,
        }),
        true,
    );
    assert.equal(
        shouldRestoreCachedOfflineSession({
            error: Object.assign(new Error("Not authenticated"), {
                status: 401,
            }),
            online: false,
            hasAccessToken: true,
            cachedUser,
        }),
        false,
    );
    assert.equal(
        shouldRestoreCachedOfflineSession({
            error: new TypeError("Failed to fetch"),
            online: false,
            hasAccessToken: false,
            cachedUser,
        }),
        false,
    );
});

test("offline logout still clears the local credential and cached identity", async () => {
    let cleared = 0;
    await assert.rejects(
        logoutWithMandatoryLocalCleanup({
            remoteLogout: async () => {
                throw new TypeError("offline");
            },
            clearLocalSession: () => {
                cleared += 1;
            },
        }),
        /offline/,
    );
    assert.equal(cleared, 1);
});

test("logout revokes the local runtime before a slow server response settles", async () => {
    let releaseRemote!: () => void;
    const remote = new Promise<void>((resolve) => {
        releaseRemote = resolve;
    });
    let cleared = 0;

    const logout = logoutWithMandatoryLocalCleanup({
        remoteLogout: () => remote,
        clearLocalSession: () => {
            cleared += 1;
        },
    });

    await Promise.resolve();
    assert.equal(cleared, 1);
    releaseRemote();
    assert.equal(await logout, true);
    assert.equal(cleared, 1);
});

test("cached auth user storage rejects malformed values", () => {
    const values = new Map<string, string>();
    const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    };
    writeCachedAuthUser(
        { id: "user-1", username: "listener", role: "user" },
        storage,
    );
    assert.deepEqual(readCachedAuthUser(storage), {
        id: "user-1",
        username: "listener",
        role: "user",
    });

    values.set("soundspan_cached_auth_user_v1", '{"id":7}');
    assert.equal(readCachedAuthUser(storage), null);
});
