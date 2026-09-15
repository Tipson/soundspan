import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    AUTH_SESSION_CHANGE_KEY,
    readCachedAuthUser,
    writeCachedAuthUser,
} from "../../lib/auth-offline-session";

GlobalRegistrator.register({ url: "https://soundspan.test/" });
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type TestUser = {
    id: string;
    username: string;
    role: string;
    onboardingComplete: boolean;
};

const state = {
    pathname: "/",
    token: "token-a" as string | null,
    refreshToken: "refresh-a" as string | null,
    currentUser: {
        id: "user-a",
        username: "alice",
        role: "user",
        onboardingComplete: true,
    } as TestUser,
    getCurrentUser: null as null | (() => Promise<TestUser>),
    sessionGeneration: 0,
    reloadCalls: 0,
    queryClearCalls: 0,
    queryClearCallsWhenUserBRendered: null as number | null,
    routed: [] as string[],
};
const router = {
    push: (path: string) => state.routed.push(path),
};

mock.module("next/navigation", {
    namedExports: {
        usePathname: () => state.pathname,
        useRouter: () => router,
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCurrentUser: () =>
                state.getCurrentUser?.() ?? Promise.resolve(state.currentUser),
            getToken: () => state.token,
            reloadTokenFromStorage: () => {
                state.reloadCalls += 1;
                state.sessionGeneration += 1;
                return state.token;
            },
            getSessionGeneration: () => state.sessionGeneration,
            setToken: (token: string) => {
                state.token = token;
                state.refreshToken = null;
                state.sessionGeneration += 1;
            },
            clearToken: () => {
                state.token = null;
                state.refreshToken = null;
                state.sessionGeneration += 1;
            },
            get: async () => ({ hasAccount: true }),
            login: async () => {
                state.sessionGeneration += 1;
                return state.currentUser;
            },
            logout: async () => undefined,
        },
    },
});

mock.module("@/lib/query-client", {
    namedExports: {
        getQueryClient: () => ({
            clear: () => {
                state.queryClearCalls += 1;
            },
        }),
        retireQueryClientForAuthRuntime: (queryClient: { clear: () => void }) =>
            queryClient.clear(),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
            warn: () => undefined,
        },
    },
});

beforeEach(() => {
    state.pathname = "/";
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: true,
    });
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    state.token = "token-a";
    state.refreshToken = "refresh-a";
    state.currentUser = {
        id: "user-a",
        username: "alice",
        role: "user",
        onboardingComplete: true,
    };
    state.getCurrentUser = null;
    state.sessionGeneration = 0;
    state.reloadCalls = 0;
    state.queryClearCalls = 0;
    state.queryClearCallsWhenUserBRendered = null;
    state.routed.length = 0;
});

after(async () => {
    await GlobalRegistrator.unregister();
});

async function flush(): Promise<void> {
    await React.act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
}

async function renderAuthState(): Promise<{
    container: HTMLElement;
    login: () => Promise<void>;
    logout: () => Promise<void>;
    rerender: () => Promise<void>;
    unmount: () => void;
}> {
    const { createRoot } = await import("react-dom/client");
    const { AuthProvider, useAuth } = await import("../../lib/auth-context");
    let invokeLogin: (() => Promise<void>) | null = null;
    let invokeLogout: (() => void) | null = null;

    function Probe() {
        const { isAuthenticated, isLoading, user, login, logout } = useAuth();
        invokeLogin = () => login("bob", "password-b");
        invokeLogout = () => void logout();
        if (
            isAuthenticated &&
            user?.id === "user-b" &&
            state.queryClearCallsWhenUserBRendered === null
        ) {
            state.queryClearCallsWhenUserBRendered = state.queryClearCalls;
        }
        return React.createElement(
            "output",
            { "data-loading": isLoading },
            isAuthenticated && user ? user.id : "signed-out",
        );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(AuthProvider, null, React.createElement(Probe)),
        );
    });
    await flush();
    return {
        container,
        rerender: async () => {
            await React.act(async () =>
                root.render(
                    React.createElement(
                        AuthProvider,
                        null,
                        React.createElement(Probe),
                    ),
                ),
            );
        },
        login: async () => {
            await React.act(async () => {
                await invokeLogin?.();
            });
        },
        logout: async () => {
            await React.act(async () => {
                invokeLogout?.();
                await Promise.resolve();
            });
        },
        unmount: () => {
            void React.act(() => root.unmount());
            container.remove();
        },
    };
}

async function dispatchSessionChange(): Promise<void> {
    await React.act(async () => {
        window.dispatchEvent(
            new StorageEvent("storage", {
                key: AUTH_SESSION_CHANGE_KEY,
                newValue: "opaque-generation",
            }),
        );
        await Promise.resolve();
    });
}

test("known-offline startup opens the cached owner's runtime without waiting for auth", async () => {
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: false,
    });
    writeCachedAuthUser(state.currentUser);
    let calls = 0;
    state.getCurrentUser = () => {
        calls += 1;
        return new Promise<TestUser>(() => undefined);
    };
    const { container, unmount } = await renderAuthState();
    try {
        assert.equal(container.textContent, "user-a");
        assert.equal(calls, 0);
        assert.equal(
            localStorage.getItem("soundspan_playback_owner_id"),
            "user-a",
        );
    } finally {
        unmount();
    }
});

test("cached startup stays usable while online connectivity is a black hole, then honors a rejection", async () => {
    writeCachedAuthUser(state.currentUser);
    let rejectUser!: (error: unknown) => void;
    state.getCurrentUser = () =>
        new Promise((_resolve, reject) => {
            rejectUser = reject;
        });
    const { container, unmount } = await renderAuthState();
    try {
        assert.equal(container.textContent, "user-a");
        assert.equal(
            container.firstElementChild?.getAttribute("data-loading"),
            "false",
        );
        await React.act(async () => {
            rejectUser(Object.assign(new Error("revoked"), { status: 401 }));
        });
        await flush();
        assert.equal(container.textContent, "signed-out");
        assert.equal(readCachedAuthUser(), null);
    } finally {
        unmount();
    }
});

test("background validation retires the cached owner's runtime before activating another account", async () => {
    writeCachedAuthUser(state.currentUser);
    state.currentUser = { ...state.currentUser, id: "user-b" };
    const { container, unmount } = await renderAuthState();
    try {
        assert.equal(container.textContent, "user-b");
        assert.ok((state.queryClearCallsWhenUserBRendered ?? 0) > 0);
    } finally {
        unmount();
    }
});

test("opening another page cannot invalidate an explicit rejection of the cached startup account", async () => {
    writeCachedAuthUser(state.currentUser);
    let rejectUser!: (error: unknown) => void;
    state.getCurrentUser = () =>
        new Promise((_resolve, reject) => {
            rejectUser = reject;
        });
    const { container, rerender, unmount } = await renderAuthState();
    try {
        assert.equal(container.textContent, "user-a");
        state.pathname = "/library";
        window.history.pushState({}, "", "/library");
        await rerender();
        await React.act(async () => {
            rejectUser(Object.assign(new Error("revoked"), { status: 403 }));
        });
        await flush();
        assert.equal(container.textContent, "signed-out");
        assert.equal(readCachedAuthUser(), null);
    } finally {
        unmount();
    }
});

test("offline cached identity is not restored without a credential", async () => {
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: false,
    });
    writeCachedAuthUser(state.currentUser);
    state.token = null;
    state.getCurrentUser = async () => {
        throw new TypeError("offline");
    };
    const { container, unmount } = await renderAuthState();
    try {
        assert.equal(container.textContent, "signed-out");
    } finally {
        unmount();
    }
});

test("logout in another tab immediately revokes this tab's user and runtime", async () => {
    const { container, unmount } = await renderAuthState();
    assert.equal(container.textContent, "user-a");

    state.token = null;
    await dispatchSessionChange();
    await flush();

    assert.equal(container.textContent, "signed-out");
    assert.equal(state.reloadCalls, 1);
    assert.equal(state.queryClearCalls, 1);
    assert.equal(state.routed.at(-1), "/login");
    unmount();
});

test("login as another user revokes the old runtime before publishing the new identity", async () => {
    const { container, unmount } = await renderAuthState();
    assert.equal(container.textContent, "user-a");

    let resolveUser!: (user: TestUser) => void;
    state.token = "token-b";
    state.getCurrentUser = () =>
        new Promise<TestUser>((resolve) => {
            resolveUser = resolve;
        });
    await dispatchSessionChange();
    await flush();

    assert.equal(container.textContent, "signed-out");
    await React.act(async () => {
        resolveUser({
            id: "user-b",
            username: "bob",
            role: "user",
            onboardingComplete: true,
        });
        await Promise.resolve();
    });
    await flush();

    assert.equal(container.textContent, "user-b");
    assert.equal(state.reloadCalls, 1);
    assert.equal(state.queryClearCalls, 1);
    unmount();
});

test("same-tab logout invalidates an in-flight cross-tab user validation", async () => {
    const { container, logout, unmount } = await renderAuthState();
    assert.equal(container.textContent, "user-a");

    let resolveUser!: (user: TestUser) => void;
    state.token = "token-b";
    state.getCurrentUser = () =>
        new Promise<TestUser>((resolve) => {
            resolveUser = resolve;
        });
    await dispatchSessionChange();
    await flush();
    assert.equal(container.textContent, "signed-out");

    await logout();
    assert.equal(container.textContent, "signed-out");
    assert.equal(state.token, null);
    assert.equal(readCachedAuthUser(), null);

    await React.act(async () => {
        resolveUser({
            id: "user-b",
            username: "bob",
            role: "user",
            onboardingComplete: true,
        });
        await Promise.resolve();
    });
    await flush();

    assert.equal(container.textContent, "signed-out");
    assert.equal(readCachedAuthUser(), null);
    unmount();
});

test("a replaced API session cannot publish an older cross-tab validation", async () => {
    const { container, unmount } = await renderAuthState();
    assert.equal(container.textContent, "user-a");

    let resolveUser!: (user: TestUser) => void;
    state.token = "token-b";
    state.getCurrentUser = () =>
        new Promise<TestUser>((resolve) => {
            resolveUser = resolve;
        });
    await dispatchSessionChange();
    await flush();
    assert.equal(container.textContent, "signed-out");

    state.sessionGeneration += 1;
    await React.act(async () => {
        resolveUser({
            id: "user-b",
            username: "bob",
            role: "user",
            onboardingComplete: true,
        });
        await Promise.resolve();
    });
    await flush();

    assert.equal(container.textContent, "signed-out");
    assert.equal(readCachedAuthUser(), null);
    unmount();
});

test("same-tab account replacement revokes user A caches before publishing user B", async () => {
    const { container, login, unmount } = await renderAuthState();
    assert.equal(container.textContent, "user-a");
    assert.equal(state.queryClearCalls, 0);
    localStorage.setItem("soundspan_current_track", '{"id":"track-a"}');
    localStorage.setItem("soundspan_queue", '[{"id":"track-a"}]');
    localStorage.setItem("soundspan_current_time", "42");
    localStorage.setItem("soundspan_is_playing", "true");
    localStorage.setItem("soundspan_volume", "0.7");

    state.currentUser = {
        id: "user-b",
        username: "bob",
        role: "user",
        onboardingComplete: true,
    };
    await login();
    await flush();

    assert.equal(container.textContent, "user-b");
    assert.ok((state.queryClearCallsWhenUserBRendered ?? 0) > 0);
    assert.deepEqual(readCachedAuthUser(), state.currentUser);
    assert.equal(localStorage.getItem("soundspan_current_track"), null);
    assert.equal(localStorage.getItem("soundspan_queue"), null);
    assert.equal(localStorage.getItem("soundspan_current_time"), null);
    assert.equal(localStorage.getItem("soundspan_is_playing"), null);
    assert.equal(localStorage.getItem("soundspan_volume"), "0.7");
    unmount();
});

test("mount validation cannot publish a user from a superseded API session", async () => {
    let resolveUser!: (user: TestUser) => void;
    state.getCurrentUser = () =>
        new Promise<TestUser>((resolve) => {
            resolveUser = resolve;
        });
    const { container, unmount } = await renderAuthState();
    assert.equal(container.textContent, "signed-out");

    state.token = "token-b";
    state.sessionGeneration += 1;
    await React.act(async () => {
        resolveUser({
            id: "user-a",
            username: "alice",
            role: "user",
            onboardingComplete: true,
        });
        await Promise.resolve();
    });
    await flush();

    assert.equal(container.textContent, "signed-out");
    assert.equal(readCachedAuthUser(), null);
    unmount();
});

test("a replacement URL token clears cached user A before pending auth validation can fail offline", async () => {
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: false,
    });
    writeCachedAuthUser(state.currentUser);
    localStorage.setItem("soundspan_playback_owner_id", "user-a");
    localStorage.setItem("soundspan_current_track", '{"id":"track-a"}');
    localStorage.setItem("soundspan_queue", '[{"id":"track-a"}]');
    window.history.replaceState({}, "", "/?token=token-b");

    let rejectUser!: (reason: unknown) => void;
    state.getCurrentUser = () =>
        new Promise<TestUser>((_resolve, reject) => {
            rejectUser = reject;
        });

    const { container, unmount } = await renderAuthState();
    try {
        assert.equal(state.token, "token-b");
        assert.equal(state.refreshToken, null);
        assert.equal(container.textContent, "signed-out");
        assert.equal(readCachedAuthUser(), null);
        assert.equal(localStorage.getItem("soundspan_playback_owner_id"), null);
        assert.equal(localStorage.getItem("soundspan_current_track"), null);
        assert.equal(localStorage.getItem("soundspan_queue"), null);
        assert.equal(state.queryClearCalls, 1);

        await React.act(async () => {
            rejectUser(new TypeError("network unavailable"));
            await Promise.resolve();
        });
        await flush();

        assert.equal(container.textContent, "signed-out");
        assert.equal(readCachedAuthUser(), null);
    } finally {
        unmount();
    }
});
