import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let jobsResponse: Array<Record<string, unknown>> = [];
let listCalls = 0;
let pushedRoutes: string[] = [];
let listImportJobsImpl = async () => ({ jobs: jobsResponse });

mock.module("@/lib/api", {
    namedExports: {
        api: {
            listImportJobs: async () => {
                listCalls += 1;
                return listImportJobsImpl();
            },
            cancelImportJob: async () => ({}),
        },
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({
            push: (route: string) => {
                pushedRoutes.push(route);
            },
        }),
    },
});

const Icon = () => React.createElement("i");
mock.module("lucide-react", {
    namedExports: {
        Loader2: Icon,
        CheckCircle2: Icon,
        XCircle: Icon,
        Ban: Icon,
        Clock: Icon,
        ArrowRight: Icon,
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
    pushedRoutes = [];
    listImportJobsImpl = async () => ({ jobs: jobsResponse });
    document.body.replaceChildren();
});

async function flushAsync(): Promise<void> {
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

test("links to a playlist that completed after its job was cancelled and shows the warning", async () => {
    jobsResponse = [
        {
            id: "job-cancelled-after-create",
            sourceType: "spotify",
            playlistName: "Recovered Playlist",
            requestedPlaylistName: null,
            status: "cancelled",
            progress: 100,
            summary: {
                total: 2,
                local: 2,
                youtube: 0,
                tidal: 0,
                unresolved: 0,
            },
            createdPlaylistId: "playlist-created-before-cancel",
            error: "Cancellation requested after playlist creation completed",
            createdAt: "2026-08-29T12:00:00.000Z",
        },
    ];
    const { ImportsTab } = await import("../../components/activity/ImportsTab");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(React.createElement(ImportsTab));
        });
        await flushAsync();

        assert.match(container.textContent ?? "", /Cancelled/);
        assert.match(
            container.textContent ?? "",
            /Cancellation requested after playlist creation completed/,
        );
        const viewPlaylistButton = [
            ...container.querySelectorAll("button"),
        ].find((button) => button.textContent?.includes("View Playlist"));
        assert.ok(viewPlaylistButton);

        await React.act(async () => {
            viewPlaylistButton.click();
        });
        assert.deepEqual(pushedRoutes, [
            "/playlist/playlist-created-before-cancel",
        ]);
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

test("refreshes an already-open empty tab when an import job is submitted", async () => {
    const { ImportsTab } = await import("../../components/activity/ImportsTab");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(React.createElement(ImportsTab));
        });
        await flushAsync();
        assert.match(container.textContent ?? "", /No import jobs yet/);

        jobsResponse = [
            {
                id: "job-1",
                sourceType: "spotify",
                playlistName: "Resolved Playlist",
                requestedPlaylistName: null,
                status: "pending",
                progress: 0,
                summary: null,
                createdPlaylistId: null,
                error: null,
                createdAt: "2026-08-28T12:00:00.000Z",
            },
        ];
        window.dispatchEvent(new CustomEvent("import-jobs-changed"));
        await flushAsync();

        assert.equal(listCalls, 2);
        assert.match(container.textContent ?? "", /Resolved Playlist/);
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

test("queues a fresh event refresh until the in-flight job request settles", async () => {
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

    const { ImportsTab } = await import("../../components/activity/ImportsTab");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(React.createElement(ImportsTab));
        });
        window.dispatchEvent(new CustomEvent("import-jobs-changed"));
        await flushAsync();

        assert.equal(listCalls, 1);

        initial.resolve({ jobs: [] });
        await flushAsync();
        assert.equal(listCalls, 2);

        refresh.resolve({
            jobs: [
                {
                    id: "job-latest",
                    sourceType: "spotify",
                    playlistName: "Latest Playlist",
                    requestedPlaylistName: null,
                    status: "pending",
                    progress: 0,
                    summary: null,
                    createdPlaylistId: null,
                    error: null,
                    createdAt: "2026-08-28T12:00:00.000Z",
                },
            ],
        });
        await flushAsync();
        assert.match(container.textContent ?? "", /Latest Playlist/);
    } finally {
        initial.resolve({ jobs: [] });
        refresh.resolve({ jobs: [] });
        await React.act(async () => root.unmount());
        container.remove();
    }
});

test("does not run a queued refresh after the tab unmounts", async () => {
    const deferred = <T>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((complete) => {
            resolve = complete;
        });
        return { promise, resolve };
    };
    const initial = deferred<{ jobs: Array<Record<string, unknown>> }>();
    listImportJobsImpl = async () => initial.promise;

    const { ImportsTab } = await import("../../components/activity/ImportsTab");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(React.createElement(ImportsTab));
    });
    window.dispatchEvent(new CustomEvent("import-jobs-changed"));
    await flushAsync();
    assert.equal(listCalls, 1);

    await React.act(async () => root.unmount());
    initial.resolve({ jobs: [] });
    await flushAsync();

    assert.equal(listCalls, 1);
    container.remove();
});

test("skips an interval tick while the previous poll remains in flight", async () => {
    const deferred = <T>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((complete) => {
            resolve = complete;
        });
        return { promise, resolve };
    };
    const pendingPoll = deferred<{ jobs: Array<Record<string, unknown>> }>();
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
            id: "job-slow",
            sourceType: "spotify",
            playlistName: "Slow Import",
            requestedPlaylistName: null,
            status: "resolving",
            progress: 50,
            summary: null,
            createdPlaylistId: null,
            error: null,
            createdAt: "2026-08-28T12:00:00.000Z",
        },
    ];

    const { ImportsTab } = await import("../../components/activity/ImportsTab");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(React.createElement(ImportsTab));
        });
        await flushAsync();
        assert.ok(intervalCallback);

        listImportJobsImpl = async () => pendingPoll.promise;
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });
        await React.act(async () => {
            intervalCallback?.();
            await Promise.resolve();
        });

        assert.equal(listCalls, 2);

        pendingPoll.resolve({
            jobs: [
                {
                    ...jobsResponse[0],
                    status: "completed",
                    progress: 100,
                    createdPlaylistId: "playlist-slow",
                },
            ],
        });
        await flushAsync();
        assert.match(container.textContent ?? "", /Completed/);
    } finally {
        pendingPoll.resolve({ jobs: [] });
        await React.act(async () => root.unmount());
        container.remove();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});
