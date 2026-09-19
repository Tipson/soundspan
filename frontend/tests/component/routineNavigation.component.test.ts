import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigationEvents: string[] = [];
const replace = mock.fn((path: string) => {
    navigationEvents.push(`replace:${path}`);
});
const push = mock.fn((_path: string) => undefined);
const router = { push, replace };
const invalidateQueries = mock.fn(async () => {
    navigationEvents.push("invalidate");
});
const reload = mock.fn(() => undefined);
const queryClient = new QueryClient();
queryClient.invalidateQueries =
    invalidateQueries as typeof queryClient.invalidateQueries;

let scanStatus: "pending" | "completed" = "pending";
let historyRequests = 0;

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => router,
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            scanLibrary: async () => ({ jobId: "scan-1" }),
            getScanStatus: async () => ({
                status: scanStatus === "completed" ? "completed" : "running",
                progress: scanStatus === "completed" ? 100 : 0,
            }),
            post: async () => ({}),
            get: async () => {
                historyRequests += 1;
                if (historyRequests === 1) {
                    throw new Error("temporary history failure");
                }
                return [
                    {
                        id: "play-1",
                        playedAt: new Date().toISOString(),
                        track: {
                            id: "track-1",
                            title: "Трек после повтора",
                            duration: 180,
                            artist: { name: "Исполнитель" },
                        },
                    },
                ];
            },
            getBrowseImageUrl: (path: string) => path,
            getCoverArtUrl: (path: string) => path,
        },
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: { error: () => undefined },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({ isAuthenticated: true }),
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({ playTracks: () => undefined }),
    },
});

mock.module("@/lib/toast-context", {
    namedExports: {
        useToast: () => ({ toast: { success: () => undefined } }),
    },
});

mock.module("@/components/track", {
    namedExports: {
        TrackList: ({
            items,
        }: {
            items: Array<{ track: { title: string } }>;
        }) =>
            React.createElement(
                "div",
                null,
                items.map((item) =>
                    React.createElement(
                        "span",
                        { key: item.track.title },
                        item.track.title,
                    ),
                ),
            ),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: { YouTubeBadge: () => null },
});

beforeEach(() => {
    navigationEvents.length = 0;
    scanStatus = "pending";
    historyRequests = 0;
    replace.mock.resetCalls();
    push.mock.resetCalls();
    invalidateQueries.mock.resetCalls();
    queryClient.clear();
    reload.mock.resetCalls();
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/sync");
    Object.defineProperty(window.location, "reload", {
        configurable: true,
        value: reload,
    });
});

after(async () => {
    await GlobalRegistrator.unregister();
});

async function mountPage(Page: React.ComponentType) {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                QueryClientProvider,
                { client: queryClient },
                React.createElement(Page),
            ),
        );
        await Promise.resolve();
        await Promise.resolve();
    });
    return {
        container,
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

function buttonWithText(container: HTMLElement, text: string) {
    return [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes(text),
    );
}

test("пропуск синхронизации инвалидирует запросы и мягко заменяет маршрут", async () => {
    const SyncPage = (await import("../../app/sync/page")).default;
    const harness = await mountPage(SyncPage);
    try {
        const skip = buttonWithText(harness.container, "Пропустить");
        assert.ok(skip);

        await React.act(async () => skip.click());

        assert.deepEqual(navigationEvents, ["invalidate", "replace:/"]);
        assert.equal(invalidateQueries.mock.callCount(), 1);
        assert.equal(replace.mock.callCount(), 1);
    } finally {
        await harness.unmount();
    }
});

test("завершение синхронизации инвалидирует запросы перед мягким переходом", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    scanStatus = "completed";
    const SyncPage = (await import("../../app/sync/page")).default;
    const harness = await mountPage(SyncPage);
    try {
        await React.act(async () => {
            t.mock.timers.tick(1_000);
            await Promise.resolve();
            await Promise.resolve();
        });
        await React.act(async () => {
            t.mock.timers.tick(1_500);
            await Promise.resolve();
        });

        assert.deepEqual(navigationEvents, ["invalidate", "replace:/"]);
        assert.equal(invalidateQueries.mock.callCount(), 1);
        assert.equal(replace.mock.callCount(), 1);
    } finally {
        await harness.unmount();
    }
});

test("повтор истории заново запрашивает данные без перезагрузки страницы", async () => {
    window.history.replaceState({}, "", "/my-history");
    const MyHistoryPage = (await import("../../app/my-history/page")).default;
    const harness = await mountPage(MyHistoryPage);
    try {
        const retry = buttonWithText(harness.container, "Повторить");
        assert.ok(retry);

        await React.act(async () => {
            retry.click();
            await Promise.resolve();
            await Promise.resolve();
        });

        assert.equal(historyRequests, 2);
        assert.match(harness.container.textContent ?? "", /Трек после повтора/);
    } finally {
        await harness.unmount();
    }
});
