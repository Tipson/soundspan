import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let jobsResponse: Array<Record<string, unknown>> = [];
let listCalls = 0;
let listImportJobsImpl = async () => ({ jobs: jobsResponse });
let invalidatedQueries: unknown[] = [];
let invalidatedClientLabels: string[] = [];

mock.module("@/lib/api", {
    namedExports: {
        api: {
            listImportJobs: async () => {
                listCalls += 1;
                return listImportJobsImpl();
            },
        },
    },
});

mock.module("@/lib/auth-context", {
    namedExports: {
        useAuth: () => ({
            isAuthenticated: true,
            isLoading: false,
            user: { id: "user-1" },
        }),
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    jobsResponse = [];
    listCalls = 0;
    listImportJobsImpl = async () => ({ jobs: jobsResponse });
    invalidatedQueries = [];
    invalidatedClientLabels = [];
    Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        value: true,
    });
    document.body.replaceChildren();
});

function importJob(id: string, status: string): Record<string, unknown> {
    return {
        id,
        status,
        sourceType: "spotify",
        playlistName: "Imported Playlist",
        requestedPlaylistName: null,
        progress: status === "completed" ? 100 : 50,
        summary: null,
        createdPlaylistId: status === "completed" ? `playlist-${id}` : null,
        error: null,
        createdAt: "2026-08-29T12:00:00.000Z",
    };
}

async function flushAsync(): Promise<void> {
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

function createTestQueryClient(label = "initial"): QueryClient {
    const queryClient = new QueryClient();
    queryClient.invalidateQueries = (async (filters: unknown) => {
        invalidatedQueries.push(filters);
        invalidatedClientLabels.push(label);
    }) as typeof queryClient.invalidateQueries;
    return queryClient;
}

async function mountMonitor(queryClient = createTestQueryClient()) {
    const { ImportCompletionMonitor } =
        await import("../../components/activity/ImportCompletionMonitor");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderWithClient = async (client: QueryClient) =>
        React.act(async () => {
            root.render(
                React.createElement(
                    QueryClientProvider,
                    { client },
                    React.createElement(ImportCompletionMonitor),
                ),
            );
        });
    await renderWithClient(queryClient);
    await flushAsync();

    return {
        replaceQueryClient: async (client: QueryClient) => {
            await renderWithClient(client);
            await flushAsync();
        },
        unmount: async () => {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

test("uses initial completed jobs only as a baseline", async () => {
    jobsResponse = [importJob("historical", "completed")];
    const monitor = await mountMonitor();

    try {
        document.dispatchEvent(new Event("visibilitychange"));
        await flushAsync();

        assert.equal(listCalls, 2);
        assert.deepEqual(invalidatedQueries, []);
    } finally {
        await monitor.unmount();
    }
});

test("does not request import jobs while offline and resumes on the online event", async () => {
    let intervalCallback: (() => void) | null = null;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((callback: TimerHandler) => {
        intervalCallback = callback as () => void;
        return 1;
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = (() =>
        undefined) as typeof globalThis.clearInterval;
    Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        value: false,
    });

    const monitor = await mountMonitor();
    try {
        assert.equal(listCalls, 0);
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 0);

        Object.defineProperty(window.navigator, "onLine", {
            configurable: true,
            value: true,
        });
        await React.act(async () => {
            window.dispatchEvent(new Event("online"));
            await Promise.resolve();
        });
        assert.equal(listCalls, 1);
    } finally {
        await monitor.unmount();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});

test("backs off exponentially and stops after bounded bootstrap retries", async () => {
    let intervalCallback: (() => void) | null = null;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    globalThis.setInterval = ((callback: TimerHandler) => {
        intervalCallback = callback as () => void;
        return 1;
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = (() =>
        undefined) as typeof globalThis.clearInterval;
    listImportJobsImpl = async () => {
        throw new Error("network unavailable");
    };

    const monitor = await mountMonitor();
    try {
        assert.equal(listCalls, 1);

        now = 3_999;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 1);

        now = 4_000;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 2);

        now = 9_999;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 2);

        now = 10_000;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 3);

        now = 22_000;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 4);

        now = 100_000;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 4);
    } finally {
        await monitor.unmount();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
        Date.now = originalDateNow;
    }
});

test("bounds retries when an idle-baseline visibility refresh fails", async () => {
    let intervalCallback: (() => void) | null = null;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    globalThis.setInterval = ((callback: TimerHandler) => {
        intervalCallback = callback as () => void;
        return 1;
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = (() =>
        undefined) as typeof globalThis.clearInterval;
    listImportJobsImpl = async () => {
        if (listCalls === 1) return { jobs: [] };
        throw new Error("transient gateway failure");
    };

    const monitor = await mountMonitor();
    try {
        assert.equal(listCalls, 1);

        document.dispatchEvent(new Event("visibilitychange"));
        await flushAsync();
        assert.equal(listCalls, 2);

        now = 3_999;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 2);

        now = 4_000;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 3);

        now = 10_000;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 4);

        now = 22_000;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 5);

        now = 100_000;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 5);
    } finally {
        await monitor.unmount();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
        Date.now = originalDateNow;
    }
});

test("recovers an active job after a failed bootstrap and publishes completion", async () => {
    let intervalCallback: (() => void) | null = null;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    globalThis.setInterval = ((callback: TimerHandler) => {
        intervalCallback = callback as () => void;
        return 1;
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = (() =>
        undefined) as typeof globalThis.clearInterval;
    jobsResponse = [importJob("bootstrap-retry", "resolving")];
    listImportJobsImpl = async () => {
        if (listCalls === 1) throw new Error("transient gateway failure");
        return { jobs: jobsResponse };
    };
    let playlistEvents = 0;
    const handlePlaylist = () => {
        playlistEvents += 1;
    };
    window.addEventListener("playlist-created", handlePlaylist);

    const monitor = await mountMonitor();
    try {
        assert.equal(listCalls, 1);
        assert.deepEqual(invalidatedQueries, []);

        now = 4_000;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 2);
        assert.deepEqual(invalidatedQueries, []);

        jobsResponse = [importJob("bootstrap-retry", "completed")];
        now = 7_000;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });

        assert.deepEqual(invalidatedQueries, [
            { queryKey: ["playlists"] },
            { queryKey: ["home", "personalized"] },
        ]);
        assert.equal(playlistEvents, 1);
    } finally {
        window.removeEventListener("playlist-created", handlePlaylist);
        await monitor.unmount();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
        Date.now = originalDateNow;
    }
});

test("resumes an active durable job after remount and publishes its completion", async () => {
    jobsResponse = [importJob("resumed", "resolving")];
    const monitor = await mountMonitor();
    let playlistEvents = 0;
    let notificationEvents = 0;
    let importJobEvents = 0;
    const handlePlaylist = () => {
        playlistEvents += 1;
    };
    const handleNotification = () => {
        notificationEvents += 1;
    };
    const handleImportJobs = () => {
        importJobEvents += 1;
    };
    window.addEventListener("playlist-created", handlePlaylist);
    window.addEventListener("notifications-changed", handleNotification);
    window.addEventListener("import-jobs-changed", handleImportJobs);

    try {
        assert.deepEqual(invalidatedQueries, []);
        jobsResponse = [importJob("resumed", "completed")];
        document.dispatchEvent(new Event("visibilitychange"));
        await flushAsync();

        assert.deepEqual(invalidatedQueries, [
            { queryKey: ["playlists"] },
            { queryKey: ["home", "personalized"] },
        ]);
        assert.equal(playlistEvents, 1);
        assert.equal(notificationEvents, 1);
        assert.equal(importJobEvents, 1);
    } finally {
        window.removeEventListener("playlist-created", handlePlaylist);
        window.removeEventListener("notifications-changed", handleNotification);
        window.removeEventListener("import-jobs-changed", handleImportJobs);
        await monitor.unmount();
    }
});

test("publishes a cancelled job when its playlist appears after multiple bounded confirmation polls", async () => {
    let intervalCallback: (() => void) | null = null;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((callback: TimerHandler) => {
        intervalCallback = callback as () => void;
        return 1;
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = (() =>
        undefined) as typeof globalThis.clearInterval;
    jobsResponse = [importJob("cancelled-late", "resolving")];
    const monitor = await mountMonitor();
    let playlistEvents = 0;
    let notificationEvents = 0;
    let importJobEvents = 0;
    const handlePlaylist = () => {
        playlistEvents += 1;
    };
    const handleNotification = () => {
        notificationEvents += 1;
    };
    const handleImportJobs = () => {
        importJobEvents += 1;
    };
    window.addEventListener("playlist-created", handlePlaylist);
    window.addEventListener("notifications-changed", handleNotification);
    window.addEventListener("import-jobs-changed", handleImportJobs);

    try {
        jobsResponse = [
            {
                ...importJob("cancelled-late", "cancelled"),
                progress: 100,
                error: "Cancelled by user",
            },
        ];
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });

        assert.equal(listCalls, 2);
        assert.deepEqual(invalidatedQueries, []);
        assert.equal(playlistEvents, 0);
        assert.equal(notificationEvents, 0);

        for (let attempt = 0; attempt < 3; attempt += 1) {
            await React.act(async () => {
                intervalCallback?.();
                await Promise.resolve();
            });
        }

        assert.equal(listCalls, 5);
        assert.deepEqual(invalidatedQueries, []);

        jobsResponse = [
            {
                ...importJob("cancelled-late", "cancelled"),
                progress: 100,
                createdPlaylistId: "playlist-cancelled-late",
                error: "Cancellation requested after playlist creation completed",
            },
        ];
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });

        assert.equal(listCalls, 6);
        assert.deepEqual(invalidatedQueries, [
            { queryKey: ["playlists"] },
            { queryKey: ["home", "personalized"] },
        ]);
        assert.equal(playlistEvents, 1);
        assert.equal(notificationEvents, 1);

        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });

        assert.equal(listCalls, 7);
        assert.deepEqual(invalidatedQueries, [
            { queryKey: ["playlists"] },
            { queryKey: ["home", "personalized"] },
        ]);
        assert.equal(playlistEvents, 1);
        assert.equal(notificationEvents, 1);
        assert.equal(importJobEvents, 1);
    } finally {
        window.removeEventListener("playlist-created", handlePlaylist);
        window.removeEventListener("notifications-changed", handleNotification);
        window.removeEventListener("import-jobs-changed", handleImportJobs);
        await monitor.unmount();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});

test("keeps a bounded confirmation window for a cancelled job loaded at baseline", async () => {
    let intervalCallback: (() => void) | null = null;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((callback: TimerHandler) => {
        intervalCallback = callback as () => void;
        return 1;
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = (() =>
        undefined) as typeof globalThis.clearInterval;
    jobsResponse = [
        {
            ...importJob("cancelled-baseline", "cancelled"),
            progress: 100,
            error: "Cancelled by user",
        },
    ];
    const monitor = await mountMonitor();

    try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await React.act(async () => {
                intervalCallback?.();
                await Promise.resolve();
            });
        }
        assert.equal(listCalls, 4);
        assert.deepEqual(invalidatedQueries, []);

        jobsResponse = [
            {
                ...importJob("cancelled-baseline", "cancelled"),
                progress: 100,
                createdPlaylistId: "playlist-cancelled-baseline",
                error: "Cancellation requested after playlist creation completed",
            },
        ];
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });

        assert.equal(listCalls, 5);
        assert.deepEqual(invalidatedQueries, [
            { queryKey: ["playlists"] },
            { queryKey: ["home", "personalized"] },
        ]);
    } finally {
        await monitor.unmount();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});

test("stops after a bounded confirmation window for an ordinary cancelled job without a playlist", async () => {
    let intervalCallback: (() => void) | null = null;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((callback: TimerHandler) => {
        intervalCallback = callback as () => void;
        return 1;
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = (() =>
        undefined) as typeof globalThis.clearInterval;
    jobsResponse = [importJob("cancelled-ordinary", "resolving")];
    const monitor = await mountMonitor();
    let playlistEvents = 0;
    let notificationEvents = 0;
    const handlePlaylist = () => {
        playlistEvents += 1;
    };
    const handleNotification = () => {
        notificationEvents += 1;
    };
    window.addEventListener("playlist-created", handlePlaylist);
    window.addEventListener("notifications-changed", handleNotification);

    try {
        jobsResponse = [
            {
                ...importJob("cancelled-ordinary", "cancelled"),
                progress: 100,
                error: "Cancelled by user",
            },
        ];
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 2);

        for (let attempt = 0; attempt < 10; attempt += 1) {
            await React.act(async () => {
                intervalCallback?.();
                await Promise.resolve();
            });
        }
        assert.equal(listCalls, 12);

        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        assert.equal(listCalls, 12);
        assert.deepEqual(invalidatedQueries, []);
        assert.equal(playlistEvents, 0);
        assert.equal(notificationEvents, 0);
    } finally {
        window.removeEventListener("playlist-created", handlePlaylist);
        window.removeEventListener("notifications-changed", handleNotification);
        await monitor.unmount();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});

test("queues a fresh import-event load behind the initial in-flight request", async () => {
    const deferred = <T>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((complete) => {
            resolve = complete;
        });
        return { promise, resolve };
    };
    const initial = deferred<{ jobs: Array<Record<string, unknown>> }>();
    const refresh = deferred<{ jobs: Array<Record<string, unknown>> }>();
    listImportJobsImpl = async () =>
        listCalls === 1 ? initial.promise : refresh.promise;

    const monitor = await mountMonitor();
    try {
        await React.act(async () => {
            window.dispatchEvent(
                new CustomEvent("import-jobs-changed", {
                    detail: { jobId: "new-job" },
                }),
            );
            await Promise.resolve();
        });
        assert.equal(listCalls, 1);

        initial.resolve({ jobs: [] });
        await flushAsync();
        assert.equal(listCalls, 2);

        refresh.resolve({ jobs: [importJob("new-job", "completed")] });
        await flushAsync();
        assert.deepEqual(invalidatedQueries, [
            { queryKey: ["playlists"] },
            { queryKey: ["home", "personalized"] },
        ]);
    } finally {
        initial.resolve({ jobs: [] });
        refresh.resolve({ jobs: [] });
        await monitor.unmount();
    }
});

test("invalidates the current query client after a runtime client replacement", async () => {
    jobsResponse = [importJob("client-reset", "resolving")];
    const monitor = await mountMonitor(createTestQueryClient("retired"));

    try {
        await monitor.replaceQueryClient(createTestQueryClient("current"));
        jobsResponse = [importJob("client-reset", "completed")];
        document.dispatchEvent(new Event("visibilitychange"));
        await flushAsync();

        assert.deepEqual(invalidatedClientLabels, ["current", "current"]);
    } finally {
        await monitor.unmount();
    }
});
