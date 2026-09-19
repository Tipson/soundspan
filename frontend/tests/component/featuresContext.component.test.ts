import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apiState = {
    featuresCalls: 0,
    uiSettingsCalls: 0,
    pendingFeatures: null as Promise<void> | null,
    federation: true,
};
const authState = {
    isAuthenticated: true,
    isLoading: false,
    user: { id: "alice" } as { id: string } | null,
};
mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => authState },
});

const apiExports = {
    api: {
        getFeatures: async () => {
            apiState.featuresCalls += 1;
            const federation = apiState.federation;
            if (apiState.pendingFeatures) await apiState.pendingFeatures;
            return {
                musicCNN: false,
                vibeEmbeddings: false,
                audioAnalysis: true,
                discovery: true,
                autoPlaylists: true,
                federation,
                vibe: {
                    provider: {
                        configured: true,
                        reachable: true,
                        checkedAt: "2026-08-17T12:00:00.000Z",
                        fresh: true,
                    },
                    activeSpace: { id: "space-active", family: "teacher" },
                    migration: null,
                },
            };
        },
        getUiSettings: async () => {
            apiState.uiSettingsCalls += 1;
            return { showVersion: false };
        },
    },
};

mock.module("@/lib/api", {
    namedExports: apiExports,
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    apiState.featuresCalls = 0;
    apiState.uiSettingsCalls = 0;
    apiState.pendingFeatures = null;
    apiState.federation = true;
    authState.isAuthenticated = true;
    authState.isLoading = false;
    authState.user = { id: "alice" };
    setVisibility("visible");
});

function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: state,
    });
}

async function changeVisibility(state: DocumentVisibilityState): Promise<void> {
    await React.act(async () => {
        setVisibility(state);
        document.dispatchEvent(new Event("visibilitychange"));
    });
}

async function flushMicrotasks(): Promise<void> {
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

async function mountProvider() {
    const { FeaturesProvider, useFeatures } =
        await import("../../lib/features-context");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Consumer() {
        const { loading, federation } = useFeatures();
        return React.createElement(
            "span",
            null,
            JSON.stringify({ loading, federation }),
        );
    }
    async function render() {
        await React.act(async () => {
            root.render(
                React.createElement(
                    FeaturesProvider,
                    null,
                    React.createElement(Consumer),
                ),
            );
        });
        await flushMicrotasks();
    }
    await render();

    return {
        render,
        state: () =>
            JSON.parse(container.textContent ?? "{}") as {
                loading: boolean;
                federation: boolean;
            },
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

async function dispatchTabReturn(): Promise<void> {
    await React.act(async () => {
        setVisibility("visible");
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
        await Promise.resolve();
    });
}

test("refreshes exactly once when a hidden tab becomes visible", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const harness = await mountProvider();
    t.after(harness.unmount);
    assert.equal(apiState.featuresCalls, 1);
    assert.equal(apiState.uiSettingsCalls, 1);

    await changeVisibility("hidden");
    await dispatchTabReturn();

    assert.equal(apiState.featuresCalls, 2);
    assert.equal(apiState.uiSettingsCalls, 2);
});

test("does not refresh on the interval while hidden", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const harness = await mountProvider();
    t.after(harness.unmount);
    assert.equal(apiState.featuresCalls, 1);
    assert.equal(apiState.uiSettingsCalls, 1);

    await changeVisibility("hidden");
    await React.act(async () => {
        t.mock.timers.tick(60_000);
        await Promise.resolve();
    });

    assert.equal(apiState.featuresCalls, 1);
    assert.equal(apiState.uiSettingsCalls, 1);
});

test("waits for authentication and does not poll the anonymous login page", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    authState.isAuthenticated = false;
    authState.isLoading = true;
    authState.user = null;
    const harness = await mountProvider();
    t.after(harness.unmount);
    assert.equal(apiState.featuresCalls, 0);
    assert.equal(apiState.uiSettingsCalls, 0);

    authState.isLoading = false;
    await harness.render();
    assert.equal(harness.state().loading, false);
    await changeVisibility("hidden");
    await dispatchTabReturn();
    await React.act(async () => {
        t.mock.timers.tick(120_000);
    });
    assert.equal(apiState.featuresCalls, 0);
    assert.equal(apiState.uiSettingsCalls, 0);

    authState.isAuthenticated = true;
    authState.user = { id: "alice" };
    await harness.render();
    assert.equal(apiState.featuresCalls, 1);
    assert.equal(apiState.uiSettingsCalls, 1);
    assert.deepEqual(harness.state(), { loading: false, federation: true });
});

test("ignores a pending response after logout and stops polling", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let resolveFeatures!: () => void;
    apiState.pendingFeatures = new Promise<void>((resolve) => {
        resolveFeatures = resolve;
    });
    const harness = await mountProvider();
    t.after(harness.unmount);
    assert.equal(apiState.featuresCalls, 1);

    authState.isAuthenticated = false;
    authState.user = null;
    await harness.render();
    await React.act(async () => {
        resolveFeatures();
    });
    await flushMicrotasks();
    assert.deepEqual(harness.state(), { loading: false, federation: false });
    await React.act(async () => {
        t.mock.timers.tick(120_000);
    });
    assert.equal(apiState.featuresCalls, 1);
    assert.equal(apiState.uiSettingsCalls, 1);
});

test("reloads for another account and rejects the previous account's delayed response", async (t) => {
    let resolveFeatures!: () => void;
    apiState.pendingFeatures = new Promise<void>((resolve) => {
        resolveFeatures = resolve;
    });
    const harness = await mountProvider();
    t.after(harness.unmount);

    authState.user = { id: "bob" };
    apiState.pendingFeatures = null;
    apiState.federation = false;
    await harness.render();
    assert.equal(apiState.featuresCalls, 2);
    await React.act(async () => {
        resolveFeatures();
    });
    await flushMicrotasks();
    assert.deepEqual(harness.state(), { loading: false, federation: false });
});
