import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Capability {
    mode: "background" | "foreground";
    explanation: string;
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const capabilityRequests: Array<Deferred<Capability>> = [];
const queueCalls = {
    resumes: [] as string[],
    pauses: [] as string[],
    settingUpdates: [] as Array<Record<string, unknown>>,
    autoSyncs: [] as Array<{
        ownerId: string;
        requests: Array<Record<string, unknown>>;
    }>,
    likedLoads: 0,
    enqueues: [] as Array<Record<string, unknown>>,
};
const vaultCalls = {
    inspections: 0,
    requests: 0,
};
const operationOrder: string[] = [];
let vaultAccessState = {
    status: "ready" as
        | "ready"
        | "setup-required"
        | "permission-required"
        | "denied"
        | "unsupported"
        | "error",
    code: null as
        | null
        | "setup_required"
        | "permission_required"
        | "permission_denied"
        | "unsupported"
        | "io",
    storageKind: "desktop-directory" as "desktop-directory" | null,
    label: "Soundspan Music",
    reason: "Music files are stored in the selected folder.",
};
let vaultRequestState = vaultAccessState;
let likedTracks: Array<Record<string, unknown>> = [];
let likedRequest: Deferred<{ tracks: Array<Record<string, unknown>> }> | null =
    null;
let likedLoadFailures = 0;
let authUserId = "user-1";
let storedRecords: Array<Record<string, unknown>> = [];
let recordStorageFailure: Error | null = null;
let reconcileRequest: Deferred<Array<Record<string, unknown>>> | null = null;
let storedQueueItems: Array<Record<string, unknown>> = [];
let queueStorageFailure: Error | null = null;
let automationSettings = {
    ownerId: "user-1",
    autoDownloadLiked: false,
    autoDownloadLikedLimit: 100,
    autoDownloadMaxBytes: 2 * 1024 * 1024 * 1024,
    updatedAt: 0,
};
const controllerChangeListeners = new Set<() => void>();
const recordSubscribers = new Set<() => void>();
const recordDownloads: Array<Record<string, unknown>> = [];
const legacyMigrations: string[] = [];
const serviceWorker = {
    addEventListener(type: string, listener: () => void) {
        if (type === "controllerchange")
            controllerChangeListeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
        if (type === "controllerchange") {
            controllerChangeListeners.delete(listener);
        }
    },
};

mock.module("@/lib/auth-context", {
    namedExports: { useAuth: () => ({ user: { id: authUserId } }) },
});

mock.module("@/features/device-offline/vault", {
    namedExports: {
        getDeviceAudioVault: () => ({
            inspectAccess: async () => {
                vaultCalls.inspections += 1;
                return vaultAccessState;
            },
            requestAccess: () => {
                vaultCalls.requests += 1;
                operationOrder.push("request-access");
                return Promise.resolve(vaultRequestState);
            },
            open: async () => {
                throw new Error("unused");
            },
        }),
    },
});

mock.module("@/features/device-offline/browserStorage", {
    namedExports: {
        getBrowserDeviceOfflineManager: () => ({
            activateOwner: () => undefined,
            retireOwner: () => undefined,
            list: async () => {
                if (recordStorageFailure) throw recordStorageFailure;
                return storedRecords;
            },
            reconcile: async () => {
                if (recordStorageFailure) throw recordStorageFailure;
                if (reconcileRequest) return reconcileRequest.promise;
                return storedRecords;
            },
            migrateLegacyCache: async (ownerId: string) => {
                legacyMigrations.push(ownerId);
                return 0;
            },
            subscribe: (listener: () => void) => {
                recordSubscribers.add(listener);
                return () => recordSubscribers.delete(listener);
            },
            download: async (input: Record<string, unknown>) => {
                operationOrder.push("download");
                recordDownloads.push(input);
                return { ...input, key: "downloaded", status: "ready" };
            },
            delete: async () => false,
        }),
        createBrowserDeviceOfflinePlaybackSource: async () => ({
            url: "blob:unused",
            revoke: () => undefined,
        }),
    },
});

mock.module("@/features/device-offline/browserQueueStorage", {
    namedExports: {
        getBrowserDeviceOfflineQueueManager: () => ({
            activateOwner: () => undefined,
            retireOwner: () => undefined,
            list: async () => {
                if (queueStorageFailure) throw queueStorageFailure;
                return storedQueueItems;
            },
            getSettings: async () => {
                if (queueStorageFailure) throw queueStorageFailure;
                return automationSettings;
            },
            updateSettings: async (
                _ownerId: string,
                patch: Record<string, unknown>,
            ) => {
                queueCalls.settingUpdates.push(patch);
                automationSettings = {
                    ...automationSettings,
                    ...patch,
                    updatedAt: 1,
                };
                return automationSettings;
            },
            enqueueBatch: async (requests: Array<Record<string, unknown>>) => {
                operationOrder.push("enqueue");
                queueCalls.enqueues.push(...requests);
                return {
                    total: requests.length,
                    queued: requests.length,
                    alreadyReady: 0,
                };
            },
            syncAutoLiked: async (
                ownerId: string,
                requests: Array<Record<string, unknown>>,
            ) => {
                queueCalls.autoSyncs.push({ ownerId, requests });
                return {
                    total: requests.length,
                    queued: requests.length,
                    alreadyReady: 0,
                };
            },
            resume: async (ownerId: string) => {
                queueCalls.resumes.push(ownerId);
            },
            pause: (ownerId: string) => queueCalls.pauses.push(ownerId),
            subscribe: () => () => undefined,
        }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getLikedPlaylist: async () => {
                queueCalls.likedLoads += 1;
                if (likedLoadFailures > 0) {
                    likedLoadFailures -= 1;
                    throw new Error("liked playlist temporarily unavailable");
                }
                if (likedRequest) return likedRequest.promise;
                return { tracks: likedTracks };
            },
            getYtMusicStreamUrl: (id: string) => `/api/ytmusic/${id}`,
            getTidalStreamUrl: (id: number) => `/api/tidal/${id}`,
            getYouTubeStreamUrl: (id: string) => `/api/youtube/${id}`,
            getStreamUrl: (id: string) => `/api/library/${id}`,
        },
    },
});

mock.module("@/features/device-offline/playbackResolver", {
    namedExports: {
        clearDeviceOfflineRuntimeState: () => undefined,
        hasPreparedDeviceOfflinePlaybackSource: () => false,
        prepareDeviceOfflinePlaybackSource: () => true,
        setDeviceOfflineRuntimeState: () => undefined,
    },
});

mock.module("@/features/device-offline/platform", {
    namedExports: {
        resolveDeviceOfflineTransferCapability: () => ({
            mode: "foreground",
            explanation: "Initial",
        }),
        resolveBrowserDeviceOfflineTransferCapability: () => {
            const request = deferred<Capability>();
            capabilityRequests.push(request);
            return request.promise;
        },
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
    capabilityRequests.length = 0;
    controllerChangeListeners.clear();
    recordSubscribers.clear();
    queueCalls.resumes.length = 0;
    queueCalls.pauses.length = 0;
    queueCalls.settingUpdates.length = 0;
    queueCalls.autoSyncs.length = 0;
    queueCalls.likedLoads = 0;
    queueCalls.enqueues.length = 0;
    vaultCalls.inspections = 0;
    vaultCalls.requests = 0;
    operationOrder.length = 0;
    recordDownloads.length = 0;
    legacyMigrations.length = 0;
    vaultAccessState = {
        status: "ready",
        code: null,
        storageKind: "desktop-directory",
        label: "Soundspan Music",
        reason: "Music files are stored in the selected folder.",
    };
    vaultRequestState = vaultAccessState;
    likedRequest = null;
    likedLoadFailures = 0;
    authUserId = "user-1";
    storedRecords = [];
    recordStorageFailure = null;
    reconcileRequest = null;
    storedQueueItems = [];
    queueStorageFailure = null;
    likedTracks = [];
    automationSettings = {
        ownerId: "user-1",
        autoDownloadLiked: false,
        autoDownloadLikedLimit: 100,
        autoDownloadMaxBytes: 2 * 1024 * 1024 * 1024,
        updatedAt: 0,
    };
    document.body.replaceChildren();
    Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: serviceWorker,
    });
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: true,
    });
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
    });
});

const manualTrack = {
    id: "yt:manual-track",
    title: "Manual track",
    duration: 180,
    artist: { name: "Artist" },
    album: { title: "Album" },
    streamSource: "youtube" as const,
    youtubeVideoId: "manual-track",
};

test("a manual collection click requests device-folder access before queueing", async () => {
    vaultAccessState = {
        status: "setup-required",
        code: "setup_required",
        storageKind: "desktop-directory",
        label: "Choose a music folder",
        reason: "Choose a folder before downloading files to this device.",
    };
    vaultRequestState = {
        status: "ready",
        code: null,
        storageKind: "desktop-directory",
        label: "My Music",
        reason: "Music files are stored in the selected folder.",
    };
    const { DeviceOfflineProvider, useDeviceOffline } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");

    function Probe() {
        const offline = useDeviceOffline();
        return React.createElement(
            "button",
            {
                onClick: () =>
                    void offline.enqueueCollection({
                        tracks: [manualTrack],
                        collectionId: "album:manual",
                        collectionLabel: "Manual album",
                    }),
            },
            offline.storage.status,
        );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                DeviceOfflineProvider,
                null,
                React.createElement(Probe),
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.textContent, "needs-setup");

    await React.act(async () => {
        (container.querySelector("button") as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(vaultCalls.requests, 1);
    assert.deepEqual(operationOrder.slice(0, 2), ["request-access", "enqueue"]);
    assert.equal(queueCalls.enqueues.length, 1);
    assert.deepEqual(legacyMigrations, ["user-1"]);
    assert.equal(container.textContent, "ready");

    await React.act(async () => root.unmount());
    container.remove();
});

test("a manual track click requests device-folder access before downloading", async () => {
    vaultAccessState = {
        status: "permission-required",
        code: "permission_required",
        storageKind: "desktop-directory",
        label: "My Music",
        reason: "Allow Soundspan to write to the selected folder.",
    };
    vaultRequestState = {
        status: "ready",
        code: null,
        storageKind: "desktop-directory",
        label: "My Music",
        reason: "Music files are stored in the selected folder.",
    };
    const { DeviceOfflineProvider, useDeviceOffline } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");

    function Probe() {
        const offline = useDeviceOffline();
        return React.createElement(
            "button",
            {
                onClick: () =>
                    void offline.download({
                        track: manualTrack,
                        sourceUrl: "/api/ytmusic/stream-public/manual-track",
                    }),
            },
            offline.storage.status,
        );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                DeviceOfflineProvider,
                null,
                React.createElement(Probe),
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await React.act(async () => {
        (container.querySelector("button") as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(vaultCalls.requests, 1);
    assert.deepEqual(operationOrder.slice(0, 2), [
        "request-access",
        "download",
    ]);
    assert.equal(recordDownloads.length, 1);

    await React.act(async () => root.unmount());
    container.remove();
});

test("auto-liked never opens a picker or starts before device storage is ready", async () => {
    vaultAccessState = {
        status: "setup-required",
        code: "setup_required",
        storageKind: "desktop-directory",
        label: "Choose a music folder",
        reason: "Choose a folder before downloading files to this device.",
    };
    automationSettings = {
        ...automationSettings,
        autoDownloadLiked: true,
    };
    likedTracks = [
        {
            id: "yt:auto",
            title: "Auto",
            duration: 180,
            likedAt: "2026-08-29T10:00:00.000Z",
            source: "youtube",
            provider: { tidalTrackId: null, youtubeVideoId: "auto" },
            artist: { id: null, name: "Artist" },
            album: { id: null, title: "Album", coverArt: null },
        },
    ];
    const { DeviceOfflineProvider } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(vaultCalls.requests, 0);
    assert.equal(queueCalls.likedLoads, 0);
    assert.equal(queueCalls.autoSyncs.length, 0);
    assert.equal(queueCalls.resumes.length, 0);

    await React.act(async () => root.unmount());
    container.remove();
});

test("ready device storage resumes legacy migration once per owner activation and app mount", async (t) => {
    const { DeviceOfflineProvider } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let activeRoot = root;
    t.after(async () => {
        await React.act(async () => activeRoot.unmount());
        container.remove();
    });

    await React.act(async () => {
        root.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(legacyMigrations, ["user-1"]);

    await React.act(async () => {
        root.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(legacyMigrations, ["user-1"]);

    authUserId = "user-2";
    automationSettings = {
        ...automationSettings,
        ownerId: "user-2",
    };
    await React.act(async () => {
        root.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(legacyMigrations, ["user-1", "user-2"]);

    await React.act(async () => root.unmount());

    const nextRoot = createRoot(container);
    activeRoot = nextRoot;
    await React.act(async () => {
        nextRoot.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(legacyMigrations, ["user-1", "user-2", "user-2"]);
});

test("initial hydration does not expose a stale ready record before cache reconciliation", async () => {
    storedRecords = [
        {
            key: "possibly-evicted",
            ownerId: "user-1",
            status: "ready",
            track: { title: "Verify me first" },
        },
    ];
    reconcileRequest = deferred<Array<Record<string, unknown>>>();
    const { DeviceOfflineProvider, useDeviceOffline } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");

    function Probe() {
        const offline = useDeviceOffline();
        return React.createElement(
            "span",
            null,
            `${offline.isHydrated}:${offline.records.length}`,
        );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                DeviceOfflineProvider,
                null,
                React.createElement(Probe),
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.textContent, "false:0");

    await React.act(async () => {
        reconcileRequest?.resolve(storedRecords);
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.textContent, "true:1");

    await React.act(async () => root.unmount());
    container.remove();
});

test("a storage notification during initial hydration cannot expose an unverified ready record", async () => {
    storedRecords = [
        {
            key: "evicted-during-hydration",
            ownerId: "user-1",
            status: "ready",
            track: { title: "Do not publish before cache verification" },
        },
    ];
    const firstReconcile = deferred<Array<Record<string, unknown>>>();
    reconcileRequest = firstReconcile;
    const { DeviceOfflineProvider, useDeviceOffline } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");

    function Probe() {
        const offline = useDeviceOffline();
        return React.createElement(
            "span",
            null,
            `${offline.isHydrated}:${offline.records.length}`,
        );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                DeviceOfflineProvider,
                null,
                React.createElement(Probe),
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.textContent, "false:0");
    assert.equal(recordSubscribers.size, 1);

    const notificationReconcile = deferred<Array<Record<string, unknown>>>();
    reconcileRequest = notificationReconcile;
    await React.act(async () => {
        for (const listener of recordSubscribers) listener();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.textContent, "false:0");

    await React.act(async () => {
        firstReconcile.resolve(storedRecords);
        await firstReconcile.promise;
        await Promise.resolve();
    });
    assert.equal(container.textContent, "false:0");

    await React.act(async () => {
        notificationReconcile.resolve([]);
        await notificationReconcile.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.textContent, "true:0");

    await React.act(async () => root.unmount());
    container.remove();
});

test("storage read failures preserve the last successful device snapshot and expose retry", async () => {
    storedRecords = [
        {
            key: "ready-track",
            ownerId: "user-1",
            track: { title: "Remember me" },
        },
    ];
    storedQueueItems = [{ key: "queued-track", ownerId: "user-1" }];
    const { DeviceOfflineProvider, useDeviceOffline } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");

    function Probe() {
        const offline = useDeviceOffline();
        return React.createElement(
            "button",
            { onClick: () => void offline.retryStorage() },
            `${offline.records.length}:${offline.queueItems.length}:${offline.isHydrated}:${offline.isQueueHydrated}:${offline.storageError ?? "ok"}`,
        );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                DeviceOfflineProvider,
                null,
                React.createElement(Probe),
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.textContent, "1:1:true:true:ok");

    queueStorageFailure = new Error("queue unavailable");
    await React.act(async () => {
        (container.querySelector("button") as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
        container.textContent ?? "",
        /^1:1:true:true:.*device storage/i,
    );

    const resumesBeforeRecovery = queueCalls.resumes.length;
    queueStorageFailure = null;
    await React.act(async () => {
        (container.querySelector("button") as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.textContent, "1:1:true:true:ok");
    assert.ok(queueCalls.resumes.length > resumesBeforeRecovery);

    await React.act(async () => root.unmount());
    container.remove();
});

test("an initial records storage failure does not block online audio runtime readiness", async () => {
    recordStorageFailure = new Error("records unavailable");
    const { DeviceOfflineProvider, useDeviceOffline } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");

    function Probe() {
        const offline = useDeviceOffline();
        return React.createElement(
            "span",
            null,
            `${offline.isHydrated}:${offline.records.length}:${offline.storageError ?? "ok"}`,
        );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                DeviceOfflineProvider,
                null,
                React.createElement(Probe),
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.match(container.textContent ?? "", /^true:0:.*device storage/i);

    await React.act(async () => root.unmount());
    container.remove();
});

test("enabled device automation imports My Liked and wakes after a successful like", async () => {
    automationSettings = {
        ...automationSettings,
        autoDownloadLiked: true,
        autoDownloadLikedLimit: 25,
    };
    likedTracks = [
        {
            id: "yt:video-1",
            title: "One",
            duration: 180,
            trackNo: null,
            filePath: null,
            likedAt: "2026-08-29T10:00:00.000Z",
            source: "youtube",
            provider: {
                tidalTrackId: null,
                youtubeVideoId: "video-1",
            },
            artist: { id: null, name: "Artist" },
            album: { id: null, title: "Album", coverArt: null },
        },
    ];
    const { DeviceOfflineProvider } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { publishDeviceOfflineLikedChange } =
        await import("../../features/device-offline/likedAutomation");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(queueCalls.autoSyncs.length, 1);
    assert.equal(queueCalls.autoSyncs[0].ownerId, "user-1");
    assert.deepEqual(
        queueCalls.autoSyncs[0].requests.map((request) => ({
            management: request.management,
            sourceUrl: request.sourceUrl,
            ownerId: request.ownerId,
        })),
        [
            {
                management: "auto-liked",
                sourceUrl: "/api/ytmusic/video-1",
                ownerId: "user-1",
            },
        ],
    );

    await React.act(async () => {
        publishDeviceOfflineLikedChange();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(queueCalls.autoSyncs.length, 2);

    await React.act(async () => root.unmount());
    container.remove();
});

test("a like notification during an active sync schedules one fresh My Liked snapshot", async () => {
    automationSettings = {
        ...automationSettings,
        autoDownloadLiked: true,
    };
    likedRequest = deferred();
    const nextLikedTrack = {
        id: "yt:video-2",
        title: "Two",
        duration: 180,
        trackNo: null,
        filePath: null,
        likedAt: "2026-08-29T11:00:00.000Z",
        source: "youtube",
        provider: {
            tidalTrackId: null,
            youtubeVideoId: "video-2",
        },
        artist: { id: null, name: "Artist" },
        album: { id: null, title: "Album", coverArt: null },
    };
    const { DeviceOfflineProvider } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { publishDeviceOfflineLikedChange } =
        await import("../../features/device-offline/likedAutomation");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.equal(queueCalls.likedLoads, 1);

    await React.act(async () => {
        publishDeviceOfflineLikedChange();
        await Promise.resolve();
    });
    likedTracks = [nextLikedTrack];
    const firstRequest = likedRequest;
    likedRequest = null;
    await React.act(async () => {
        firstRequest?.resolve({ tracks: [] });
        await firstRequest?.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(queueCalls.likedLoads, 2);
    assert.equal(queueCalls.autoSyncs.length, 2);
    assert.equal(
        queueCalls.autoSyncs[1]?.requests[0]?.sourceUrl,
        "/api/ytmusic/video-2",
    );

    await React.act(async () => root.unmount());
    container.remove();
});

test("auto-liked resumes after offline and hidden states and refreshes cross-device likes on focus", async (t) => {
    automationSettings = {
        ...automationSettings,
        autoDownloadLiked: true,
    };
    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: false,
    });
    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
    });
    likedTracks = [
        {
            id: "yt:remote-1",
            title: "Remote one",
            duration: 180,
            likedAt: "2026-08-29T10:00:00.000Z",
            source: "youtube",
            provider: { tidalTrackId: null, youtubeVideoId: "remote-1" },
            artist: { id: null, name: "Artist" },
            album: { id: null, title: "Album", coverArt: null },
        },
    ];
    const { DeviceOfflineProvider } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });

    await React.act(async () => {
        root.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(queueCalls.likedLoads, 0);

    Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: true,
    });
    await React.act(async () => {
        window.dispatchEvent(new Event("online"));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(queueCalls.likedLoads, 0);

    Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
    });
    await React.act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(queueCalls.likedLoads, 1);
    assert.equal(
        queueCalls.autoSyncs[0]?.requests[0]?.sourceUrl,
        "/api/ytmusic/remote-1",
    );

    likedTracks = [
        {
            id: "yt:remote-2",
            title: "Remote two",
            duration: 180,
            likedAt: "2026-08-29T11:00:00.000Z",
            source: "youtube",
            provider: { tidalTrackId: null, youtubeVideoId: "remote-2" },
            artist: { id: null, name: "Artist" },
            album: { id: null, title: "Album", coverArt: null },
        },
    ];
    await React.act(async () => {
        window.dispatchEvent(new Event("focus"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(queueCalls.likedLoads, 2);
    assert.equal(
        queueCalls.autoSyncs[1]?.requests[0]?.sourceUrl,
        "/api/ytmusic/remote-2",
    );
});

test("return-to-app signals coalesce and retry auto-liked after an API failure", async (t) => {
    automationSettings = {
        ...automationSettings,
        autoDownloadLiked: true,
    };
    likedLoadFailures = 1;
    const { DeviceOfflineProvider } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        await React.act(async () => root.unmount());
        container.remove();
    });

    await React.act(async () => {
        root.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(queueCalls.likedLoads, 1);
    assert.equal(queueCalls.autoSyncs.length, 0);

    likedRequest = deferred();
    await React.act(async () => {
        window.dispatchEvent(new Event("focus"));
        await Promise.resolve();
    });
    assert.equal(queueCalls.likedLoads, 2);

    await React.act(async () => {
        window.dispatchEvent(new Event("online"));
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
    });
    likedTracks = [
        {
            id: "yt:coalesced",
            title: "Coalesced",
            duration: 180,
            likedAt: "2026-08-29T12:00:00.000Z",
            source: "youtube",
            provider: { tidalTrackId: null, youtubeVideoId: "coalesced" },
            artist: { id: null, name: "Artist" },
            album: { id: null, title: "Album", coverArt: null },
        },
    ];
    const activeRequest = likedRequest;
    likedRequest = null;
    await React.act(async () => {
        activeRequest?.resolve({ tracks: [] });
        await activeRequest?.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(queueCalls.likedLoads, 3);
    assert.equal(queueCalls.autoSyncs.length, 2);
    assert.equal(
        queueCalls.autoSyncs[1]?.requests[0]?.sourceUrl,
        "/api/ytmusic/coalesced",
    );
});

test("device automation settings are owner-scoped, local, and default off", async () => {
    const { DeviceOfflineProvider, useDeviceOffline } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");

    function Probe() {
        const offline = useDeviceOffline() as ReturnType<
            typeof useDeviceOffline
        > & {
            automationSettings: typeof automationSettings | null;
            updateAutomationSettings(
                patch: Record<string, unknown>,
            ): Promise<void>;
        };
        return React.createElement(
            "button",
            {
                onClick: () =>
                    void offline.updateAutomationSettings({
                        autoDownloadLiked: true,
                    }),
            },
            String(offline.automationSettings?.autoDownloadLiked),
        );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                DeviceOfflineProvider,
                null,
                React.createElement(Probe),
            ),
        );
        await Promise.resolve();
    });
    assert.equal(container.textContent, "false");
    await React.act(async () => {
        (container.querySelector("button") as HTMLButtonElement).click();
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.deepEqual(queueCalls.settingUpdates, [{ autoDownloadLiked: true }]);
    assert.equal(container.textContent, "true");
    assert.ok(queueCalls.resumes.includes("user-1"));

    await React.act(async () => root.unmount());
    container.remove();
});

test("a late My Liked response cannot enqueue downloads after the account changes", async () => {
    automationSettings = {
        ...automationSettings,
        autoDownloadLiked: true,
    };
    likedRequest = deferred();
    const { DeviceOfflineProvider } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
        root.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await Promise.resolve();
        await Promise.resolve();
    });
    assert.equal(queueCalls.likedLoads, 1);

    const resumesBeforeAccountChange = queueCalls.resumes.length;
    authUserId = "user-2";
    automationSettings = {
        ...automationSettings,
        ownerId: "user-2",
        autoDownloadLiked: false,
    };
    await React.act(async () => {
        root.render(
            React.createElement(DeviceOfflineProvider, null, "content"),
        );
        await Promise.resolve();
    });

    await React.act(async () => {
        likedRequest?.resolve({ tracks: [] });
        await likedRequest?.promise;
        await Promise.resolve();
    });
    assert.equal(queueCalls.autoSyncs.length, 0);
    assert.equal(queueCalls.resumes.length, resumesBeforeAccountChange + 1);
    assert.equal(queueCalls.resumes.at(-1), "user-2");

    await React.act(async () => root.unmount());
    container.remove();
});

test("late capability lookup cannot overwrite a newer service worker result", async () => {
    const { DeviceOfflineProvider, useDeviceOffline } =
        await import("../../features/device-offline/DeviceOfflineProvider");
    const { createRoot } = await import("react-dom/client");

    function Probe() {
        return React.createElement(
            "span",
            null,
            useDeviceOffline().capability.mode,
        );
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(
            React.createElement(
                DeviceOfflineProvider,
                null,
                React.createElement(Probe),
            ),
        );
    });
    assert.equal(capabilityRequests.length, 1);

    await React.act(async () => {
        for (const listener of controllerChangeListeners) listener();
        await Promise.resolve();
    });
    assert.equal(capabilityRequests.length, 2);

    await React.act(async () => {
        capabilityRequests[1].resolve({
            mode: "background",
            explanation: "New worker",
        });
        await capabilityRequests[1].promise;
    });
    assert.equal(container.textContent, "background");

    await React.act(async () => {
        capabilityRequests[0].resolve({
            mode: "foreground",
            explanation: "Old worker timeout",
        });
        await capabilityRequests[0].promise;
    });
    assert.equal(container.textContent, "background");

    await React.act(async () => root.unmount());
    container.remove();
});
