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
let retryCalls: string[] = [];
let cancelCalls = 0;
let pushedRoutes: string[] = [];
let listImportJobsImpl = async () => ({ jobs: jobsResponse });
let cancelImportJobImpl = async () => ({});
let retryImportJobImpl = async (_jobId: string) => ({ job: jobsResponse[0] });

mock.module("@/lib/api", {
    namedExports: {
        api: {
            listImportJobs: async () => {
                listCalls += 1;
                return listImportJobsImpl();
            },
            cancelImportJob: async () => {
                cancelCalls += 1;
                return cancelImportJobImpl();
            },
            retryImportJob: async (jobId: string) => {
                retryCalls.push(jobId);
                return retryImportJobImpl(jobId);
            },
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
    retryCalls = [];
    cancelCalls = 0;
    pushedRoutes = [];
    listImportJobsImpl = async () => ({ jobs: jobsResponse });
    cancelImportJobImpl = async () => ({});
    retryImportJobImpl = async (_jobId: string) => ({ job: jobsResponse[0] });
    document.body.replaceChildren();
});

test("shows the playlist immediately while unresolved tracks continue in the background", async () => {
    jobsResponse = [
        {
            id: "job-progressive",
            sourceType: "spotify",
            playlistName: "Large Playlist",
            requestedPlaylistName: null,
            status: "resolving",
            progress: 56,
            summary: {
                total: 1400,
                local: 100,
                youtube: 900,
                tidal: 0,
                unresolved: 400,
            },
            createdPlaylistId: "playlist-progressive",
            resolutionStartedAt: "2026-09-02T12:00:00.000Z",
            resolutionProcessed: 1000,
            resolutionAttempt: 1,
            estimatedRemainingSeconds: 420,
            error: null,
            createdAt: "2026-09-02T11:59:45.000Z",
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

        assert.match(container.textContent ?? "", /1000 готово/);
        assert.match(container.textContent ?? "", /400 ищем/);
        assert.match(container.textContent ?? "", /Осталось примерно 7 мин/);
        const viewPlaylistButton = [
            ...container.querySelectorAll("button"),
        ].find((button) => button.textContent?.includes("Открыть плейлист"));
        assert.ok(viewPlaylistButton);

        await React.act(async () => viewPlaylistButton.click());
        assert.deepEqual(pushedRoutes, ["/playlist/playlist-progressive"]);
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

test("retries only unresolved tracks for a completed import", async () => {
    jobsResponse = [
        {
            id: "job-retry",
            sourceType: "spotify",
            playlistName: "Partial Playlist",
            requestedPlaylistName: null,
            status: "completed",
            progress: 100,
            summary: {
                total: 10,
                local: 2,
                youtube: 6,
                tidal: 0,
                unresolved: 2,
            },
            createdPlaylistId: "playlist-retry",
            resolutionStartedAt: "2026-09-02T12:00:00.000Z",
            resolutionProcessed: 10,
            resolutionAttempt: 1,
            estimatedRemainingSeconds: null,
            error: null,
            createdAt: "2026-09-02T11:59:45.000Z",
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

        const retryButton = [...container.querySelectorAll("button")].find(
            (button) => button.textContent?.includes("Повторить поиск"),
        );
        assert.ok(retryButton);
        await React.act(async () => retryButton.click());

        assert.deepEqual(retryCalls, ["job-retry"]);
        assert.equal(listCalls, 2);
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

async function flushAsync(): Promise<void> {
    await React.act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

test("a failed initial read is not presented as an empty import history and can be retried", async () => {
    listImportJobsImpl = async () => {
        throw new Error("network failure");
    };
    const { ImportsTab } = await import("../../components/activity/ImportsTab");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await React.act(async () =>
            root.render(React.createElement(ImportsTab)),
        );
        await flushAsync();
        assert.match(
            container.querySelector('[role="alert"]')?.textContent ?? "",
            /Не удалось обновить импорты/,
        );
        assert.doesNotMatch(container.textContent ?? "", /Импортов пока нет/);
        const retry = [...container.querySelectorAll("button")].find((button) =>
            button.textContent?.includes("Обновить"),
        );
        assert.ok(retry);
        listImportJobsImpl = async () => ({ jobs: [] });
        await React.act(async () => retry.click());
        await flushAsync();
        assert.equal(container.querySelector('[role="alert"]'), null);
        assert.match(container.textContent ?? "", /Импортов пока нет/);
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

test("a failed refresh preserves the last known playlist and marks progress as stale", async () => {
    jobsResponse = [
        {
            id: "job-last-known",
            status: "completed",
            playlistName: "Сохранённый плейлист",
            sourceType: "spotify",
            progress: 100,
            summary: { total: 10, unresolved: 2 },
            createdPlaylistId: "saved",
            createdAt: "2026-09-05T00:00:00.000Z",
        },
    ];
    const { ImportsTab } = await import("../../components/activity/ImportsTab");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await React.act(async () =>
            root.render(React.createElement(ImportsTab)),
        );
        await flushAsync();
        listImportJobsImpl = async () => {
            throw new Error("offline");
        };
        window.dispatchEvent(new CustomEvent("import-jobs-changed"));
        await flushAsync();
        assert.match(container.textContent ?? "", /Сохранённый плейлист/);
        assert.match(container.textContent ?? "", /8 готово/);
        assert.match(
            container.querySelector('[role="alert"]')?.textContent ?? "",
            /последние полученные данные/,
        );
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

for (const operation of ["cancel", "retry"] as const) {
    test(`a rejected ${operation} action stays visible and is recoverable`, async () => {
        jobsResponse = [
            {
                id: "job-action",
                status: operation === "cancel" ? "resolving" : "completed",
                playlistName: "Импорт",
                sourceType: "spotify",
                progress: 50,
                summary: { total: 10, unresolved: 5 },
                createdAt: "2026-09-05T00:00:00.000Z",
            },
        ];
        const fail = async (): Promise<never> => {
            throw new Error("private upstream details");
        };
        if (operation === "cancel") cancelImportJobImpl = fail;
        else retryImportJobImpl = fail;
        const { ImportsTab } =
            await import("../../components/activity/ImportsTab");
        const { createRoot } = await import("react-dom/client");
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await React.act(async () =>
                root.render(React.createElement(ImportsTab)),
            );
            await flushAsync();
            const label =
                operation === "cancel" ? "Отменить" : "Повторить поиск";
            const button = [...container.querySelectorAll("button")].find((b) =>
                b.textContent?.includes(label),
            );
            assert.ok(button);
            await React.act(async () => button.click());
            await flushAsync();
            assert.match(
                container.querySelector('[role="alert"]')?.textContent ?? "",
                operation === "cancel"
                    ? /Не удалось отменить импорт/
                    : /Не удалось повторить поиск/,
            );
            assert.doesNotMatch(
                container.textContent ?? "",
                /private upstream details/,
            );
            cancelImportJobImpl = async () => ({});
            retryImportJobImpl = async () => ({ job: jobsResponse[0] });
            await React.act(async () => button.click());
            await flushAsync();
            assert.equal(container.querySelector('[role="alert"]'), null);
        } finally {
            await React.act(async () => root.unmount());
            container.remove();
        }
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

        assert.match(container.textContent ?? "", /Отменено/);
        assert.match(
            container.textContent ?? "",
            /Запрос на отмену поступил после создания плейлиста/,
        );
        const viewPlaylistButton = [
            ...container.querySelectorAll("button"),
        ].find((button) => button.textContent?.includes("Открыть плейлист"));
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
        assert.match(container.textContent ?? "", /Импортов пока нет/);

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

test("keeps a successful in-chain snapshot when its queued newer refresh fails", async () => {
    let finish!: (value: { jobs: Array<Record<string, unknown>> }) => void;
    const initial = new Promise<{ jobs: Array<Record<string, unknown>> }>(
        (resolve) => {
            finish = resolve;
        },
    );
    listImportJobsImpl = async () => {
        if (listCalls === 1) return initial;
        throw new Error("queued refresh failed");
    };
    const { ImportsTab } = await import("../../components/activity/ImportsTab");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await React.act(async () =>
            root.render(React.createElement(ImportsTab)),
        );
        window.dispatchEvent(new CustomEvent("import-jobs-changed"));
        await flushAsync();
        finish({
            jobs: [
                {
                    id: "latest-success",
                    status: "completed",
                    playlistName: "Полученный плейлист",
                    sourceType: "spotify",
                    progress: 100,
                    summary: { total: 10, unresolved: 0 },
                    createdAt: "2026-09-05T00:00:00.000Z",
                },
            ],
        });
        await flushAsync();
        assert.equal(listCalls, 2);
        assert.match(container.textContent ?? "", /Полученный плейлист/);
        assert.match(
            container.querySelector('[role="alert"]')?.textContent ?? "",
            /последние полученные данные/,
        );
    } finally {
        finish({ jobs: [] });
        await React.act(async () => root.unmount());
        container.remove();
    }
});

for (const operation of ["cancel", "retry"] as const) {
    test(`${operation} admits only one request per job during rapid repeated clicks`, async () => {
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        cancelImportJobImpl = async () => {
            await pending;
            return {};
        };
        retryImportJobImpl = async () => {
            await pending;
            return { job: jobsResponse[0] };
        };
        jobsResponse = [
            {
                id: "single-action",
                status: operation === "cancel" ? "resolving" : "completed",
                playlistName: "Импорт",
                sourceType: "spotify",
                progress: 50,
                summary: { total: 10, unresolved: 5 },
                createdAt: "2026-09-05T00:00:00.000Z",
            },
        ];
        const { ImportsTab } =
            await import("../../components/activity/ImportsTab");
        const { createRoot } = await import("react-dom/client");
        const container = document.createElement("div");
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await React.act(async () =>
                root.render(React.createElement(ImportsTab)),
            );
            await flushAsync();
            const label =
                operation === "cancel" ? "Отменить" : "Повторить поиск";
            const button = [...container.querySelectorAll("button")].find((b) =>
                b.textContent?.includes(label),
            );
            assert.ok(button);
            await React.act(async () => {
                button.click();
                button.click();
            });
            assert.equal(
                operation === "cancel" ? cancelCalls : retryCalls.length,
                1,
            );
            assert.equal(button.disabled, true);
            finish();
            await flushAsync();
            assert.equal(button.disabled, false);
            assert.equal(container.querySelector('[role="alert"]'), null);
        } finally {
            finish();
            await React.act(async () => root.unmount());
            container.remove();
        }
    });
}

test("actions for distinct jobs remain independent", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
        finish = resolve;
    });
    cancelImportJobImpl = async () => {
        await pending;
        return {};
    };
    jobsResponse = ["first", "second"].map((id) => ({
        id,
        status: "resolving",
        playlistName: `Импорт ${id}`,
        sourceType: "spotify",
        progress: 50,
        summary: null,
        createdAt: "2026-09-05T00:00:00.000Z",
    }));
    const { ImportsTab } = await import("../../components/activity/ImportsTab");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await React.act(async () =>
            root.render(React.createElement(ImportsTab)),
        );
        await flushAsync();
        const buttons = [...container.querySelectorAll("button")].filter(
            (button) => button.textContent?.includes("Отменить"),
        );
        assert.equal(buttons.length, 2);
        await React.act(async () => {
            buttons[0].click();
            buttons[1].click();
        });
        assert.equal(cancelCalls, 2);
        assert.ok(buttons.every((button) => button.disabled));

        finish();
        await flushAsync();
        await flushAsync();
        assert.ok(buttons.every((button) => !button.disabled));
    } finally {
        finish();
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
        assert.match(container.textContent ?? "", /Завершено/);
    } finally {
        pendingPoll.resolve({ jobs: [] });
        await React.act(async () => root.unmount());
        container.remove();
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});
