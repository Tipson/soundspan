import assert from "node:assert/strict";
import test from "node:test";
import {
    DEFAULT_DEVICE_OFFLINE_AUTOMATION_SETTINGS,
    DEVICE_OFFLINE_QUEUE_LEASE_MS,
    DeviceOfflineQueueManager,
    claimNextDeviceOfflineQueueItem,
    mergeDeviceOfflineQueueItem,
    matchesDeviceOfflineQueueVersion,
    type DeviceOfflineAutomationSettings,
    type DeviceOfflineQueueItem,
    type DeviceOfflineQueueStore,
    type DeviceOfflineQueueUpsert,
} from "../../features/device-offline/offlineQueue";
import type {
    DeviceOfflineDownloadInput,
    DeviceOfflineDownloadRecord,
    DeviceOfflineTrack,
} from "../../features/device-offline/types";

const TRACK: DeviceOfflineTrack = {
    id: "yt:video-1",
    title: "One",
    artist: { name: "Artist" },
    album: { title: "Album" },
    duration: 180,
    streamSource: "youtube",
    youtubeVideoId: "video-1",
};

class MemoryQueueStore implements DeviceOfflineQueueStore {
    readonly items = new Map<string, DeviceOfflineQueueItem>();
    readonly settings = new Map<string, DeviceOfflineAutomationSettings>();

    async listByOwner(ownerId: string): Promise<DeviceOfflineQueueItem[]> {
        return [...this.items.values()].filter(
            (item) => item.ownerId === ownerId,
        );
    }

    async getByKey(key: string): Promise<DeviceOfflineQueueItem | null> {
        return this.items.get(key) ?? null;
    }

    async upsert(
        input: DeviceOfflineQueueUpsert,
        isAuthorized?: () => boolean,
    ): Promise<DeviceOfflineQueueItem> {
        if (isAuthorized && !isAuthorized()) {
            throw new Error("Authentication session changed");
        }
        const existing = [...this.items.values()].find(
            (item) =>
                item.ownerId === input.ownerId &&
                item.trackIdentity === input.trackIdentity &&
                item.quality === input.quality,
        );
        const next = mergeDeviceOfflineQueueItem(existing ?? null, input);
        if (existing && existing.key !== next.key)
            this.items.delete(existing.key);
        this.items.set(next.key, next);
        return next;
    }

    async claimNext(
        ownerId: string,
        allowAuto: boolean,
        leaseId: string,
        now: number,
        leaseExpiresAt: number,
        isAuthorized?: () => boolean,
    ): Promise<DeviceOfflineQueueItem | null> {
        if (isAuthorized && !isAuthorized()) return null;
        const owned = await this.listByOwner(ownerId);
        if (owned.some((item) => item.status === "processing")) return null;
        const candidate = owned
            .filter(
                (item) =>
                    (item.status === "queued" ||
                        item.status === "interrupted") &&
                    (allowAuto || item.management === "manual"),
            )
            .sort((left, right) => {
                if (left.management !== right.management) {
                    return left.management === "manual" ? -1 : 1;
                }
                return left.createdAt - right.createdAt;
            })[0];
        if (!candidate) return null;
        const claimed: DeviceOfflineQueueItem = {
            ...candidate,
            status: "processing",
            attempt: candidate.attempt + 1,
            leaseId,
            leaseExpiresAt,
            updatedAt: now,
            errorMessage: null,
        };
        this.items.set(claimed.key, claimed);
        return claimed;
    }

    async putIfCurrent(
        expected: DeviceOfflineQueueItem,
        next: DeviceOfflineQueueItem,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        const current = this.items.get(expected.key) ?? null;
        if (!matchesDeviceOfflineQueueVersion(current, expected)) return false;
        this.items.set(next.key, next);
        return true;
    }

    async deleteIfCurrent(
        expected: DeviceOfflineQueueItem,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        const current = this.items.get(expected.key) ?? null;
        if (!matchesDeviceOfflineQueueVersion(current, expected)) return false;
        return this.items.delete(expected.key);
    }

    async recoverExpired(
        ownerId: string,
        now: number,
        isAuthorized?: () => boolean,
    ): Promise<void> {
        if (isAuthorized && !isAuthorized()) return;
        for (const item of await this.listByOwner(ownerId)) {
            if (
                item.status === "processing" &&
                (item.leaseExpiresAt ?? 0) <= now
            ) {
                this.items.set(item.key, {
                    ...item,
                    status: "interrupted",
                    leaseId: null,
                    leaseExpiresAt: null,
                    updatedAt: now,
                    errorMessage: "Interrupted",
                });
            }
        }
    }

    async renewLease(
        ownerId: string,
        key: string,
        leaseId: string,
        now: number,
        leaseExpiresAt: number,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        const current = this.items.get(key);
        if (
            !current ||
            current.ownerId !== ownerId ||
            current.status !== "processing" ||
            current.leaseId !== leaseId
        ) {
            return false;
        }
        this.items.set(key, {
            ...current,
            updatedAt: now,
            leaseExpiresAt,
        });
        return true;
    }

    async getSettings(
        ownerId: string,
    ): Promise<DeviceOfflineAutomationSettings | null> {
        return this.settings.get(ownerId) ?? null;
    }

    async putSettings(
        settings: DeviceOfflineAutomationSettings,
        isAuthorized?: () => boolean,
    ): Promise<void> {
        if (isAuthorized && !isAuthorized()) return;
        this.settings.set(settings.ownerId, settings);
    }
}

function readyRecord(
    ownerId: string,
    key: string,
    management: "manual" | "auto-liked",
    createdAt: number,
    totalBytes = 100,
): DeviceOfflineDownloadRecord {
    return {
        key,
        ownerId,
        trackIdentity: `track:${key}`,
        quality: "auto",
        virtualUrl: `/__offline/audio/${key}`,
        sourceUrl: `/api/library/tracks/${key}/stream`,
        track: {
            ...TRACK,
            id: key,
            youtubeVideoId: undefined,
            streamSource: undefined,
        },
        status: "ready",
        transferMode: "foreground",
        backgroundFetchId: null,
        foregroundLeaseId: null,
        foregroundLeaseExpiresAt: null,
        bytesReceived: totalBytes,
        totalBytes,
        integrityVersion: 1,
        contentType: "audio/mp4",
        persistenceGranted: true,
        management,
        attempt: 1,
        createdAt,
        updatedAt: createdAt,
        errorCode: null,
        errorMessage: null,
    };
}

function createHarness(options?: {
    online?: boolean;
    downloadGate?: Promise<void>;
    downloadListGate?: Promise<void>;
    autoDeleteGate?: Promise<void>;
    promotionGate?: Promise<void>;
    queueListGate?: Promise<void>;
    downloadDeleteGate?: Promise<void>;
    captureHeartbeat?: boolean;
    getAuthRuntimeLease?: () => {
        generation: number;
        signal: AbortSignal;
    };
    isAuthRuntimeCurrent?: (generation: number) => boolean;
}) {
    const store = new MemoryQueueStore();
    const downloads: DeviceOfflineDownloadRecord[] = [];
    let now = 1_000;
    let sequence = 0;
    let active = 0;
    let maxActive = 0;
    let online = options?.online ?? true;
    const calls: DeviceOfflineDownloadInput[] = [];
    const promoted: string[] = [];
    const deleted: string[] = [];
    let heartbeatCallback: (() => void) | null = null;
    let downloadListCalls = 0;
    const defaultAuthController = new AbortController();
    let signalDownloadListStarted!: () => void;
    const downloadListStarted = new Promise<void>((resolve) => {
        signalDownloadListStarted = resolve;
    });
    let signalAutoDeleteStarted!: () => void;
    const autoDeleteStarted = new Promise<void>((resolve) => {
        signalAutoDeleteStarted = resolve;
    });
    let signalPromotionStarted!: () => void;
    const promotionStarted = new Promise<void>((resolve) => {
        signalPromotionStarted = resolve;
    });
    let queueListCalls = 0;
    let signalQueueListStarted!: () => void;
    const queueListStarted = new Promise<void>((resolve) => {
        signalQueueListStarted = resolve;
    });
    let signalDownloadDeleteStarted!: () => void;
    const downloadDeleteStarted = new Promise<void>((resolve) => {
        signalDownloadDeleteStarted = resolve;
    });
    const originalListByOwner = store.listByOwner.bind(store);
    store.listByOwner = async (ownerId: string) => {
        queueListCalls += 1;
        if (options?.queueListGate && queueListCalls === 1) {
            signalQueueListStarted();
            await options.queueListGate;
        }
        return originalListByOwner(ownerId);
    };
    const manager = new DeviceOfflineQueueManager({
        store,
        now: () => now,
        createKey: () => `queue-${++sequence}`,
        createLeaseId: () => `lease-${sequence}-${now}`,
        isOnline: () => online,
        downloads: {
            reconcile: async (ownerId) =>
                downloads.filter((record) => record.ownerId === ownerId),
            list: async (ownerId) => {
                downloadListCalls += 1;
                if (options?.downloadListGate && downloadListCalls > 1) {
                    signalDownloadListStarted();
                    await options.downloadListGate;
                }
                return downloads.filter((record) => record.ownerId === ownerId);
            },
            download: async (input) => {
                calls.push(input);
                active += 1;
                maxActive = Math.max(maxActive, active);
                await options?.downloadGate;
                await Promise.resolve();
                active -= 1;
                const identity = input.track.youtubeVideoId
                    ? `youtube:${input.track.youtubeVideoId}`
                    : `track:${input.track.id}`;
                const record: DeviceOfflineDownloadRecord = {
                    ...readyRecord(
                        input.ownerId,
                        `download-${calls.length}`,
                        input.management ?? "manual",
                        now,
                    ),
                    trackIdentity: identity,
                    track: input.track,
                    sourceUrl: input.sourceUrl,
                };
                downloads.push(record);
                return record;
            },
            delete: async (ownerId, key, isAuthorized?: () => boolean) => {
                signalDownloadDeleteStarted();
                await options?.downloadDeleteGate;
                if (isAuthorized && !isAuthorized()) return false;
                const index = downloads.findIndex(
                    (record) =>
                        record.ownerId === ownerId && record.key === key,
                );
                if (index < 0) return false;
                deleted.push(key);
                downloads.splice(index, 1);
                return true;
            },
            deleteAutoManagedIfCurrent: async (ownerId, expected) => {
                signalAutoDeleteStarted();
                await options?.autoDeleteGate;
                const index = downloads.findIndex(
                    (record) =>
                        record.ownerId === ownerId &&
                        record.key === expected.key &&
                        record.management === "auto-liked" &&
                        record.attempt === expected.attempt &&
                        record.status === expected.status,
                );
                if (index < 0) return false;
                deleted.push(expected.key);
                downloads.splice(index, 1);
                return true;
            },
            promoteToManual: async (ownerId, key) => {
                signalPromotionStarted();
                await options?.promotionGate;
                const record = downloads.find(
                    (candidate) =>
                        candidate.ownerId === ownerId && candidate.key === key,
                );
                if (!record) return null;
                record.management = "manual";
                promoted.push(key);
                return record;
            },
        },
        scheduleLeaseHeartbeat: options?.captureHeartbeat
            ? (callback) => {
                  heartbeatCallback = callback;
                  return "heartbeat";
              }
            : undefined,
        cancelLeaseHeartbeat: () => {
            heartbeatCallback = null;
        },
        getAuthRuntimeLease:
            options?.getAuthRuntimeLease ??
            (() => ({
                generation: 0,
                signal: defaultAuthController.signal,
            })),
        isAuthRuntimeCurrent:
            options?.isAuthRuntimeCurrent ??
            ((generation: number) => generation === 0),
    });
    return {
        store,
        downloads,
        manager,
        calls,
        deleted,
        promoted,
        maxActive: () => maxActive,
        downloadListStarted,
        autoDeleteStarted,
        promotionStarted,
        queueListStarted,
        downloadDeleteStarted,
        setOnline(value: boolean) {
            online = value;
        },
        advance(ms: number) {
            now += ms;
        },
        pulseHeartbeat() {
            heartbeatCallback?.();
        },
    };
}

function request(
    ownerId: string,
    track: DeviceOfflineTrack = TRACK,
    management: "manual" | "auto-liked" = "manual",
) {
    return {
        ownerId,
        track,
        sourceUrl: `/api/ytmusic/stream-public/${track.youtubeVideoId}`,
        quality: "auto",
        management,
        collectionId: "album:one",
        collectionLabel: "Album",
    } as const;
}

test("batch queue deduplicates per owner and track quality and processes serially", async () => {
    const harness = createHarness();
    const second = {
        ...TRACK,
        id: "yt:video-2",
        youtubeVideoId: "video-2",
        title: "Two",
    };

    await harness.manager.enqueueBatch([
        request("user-1"),
        request("user-1"),
        request("user-1", second),
        request("user-2"),
    ]);

    assert.equal((await harness.manager.list("user-1")).length, 2);
    assert.equal((await harness.manager.list("user-2")).length, 1);
    await Promise.all([
        harness.manager.resume("user-1"),
        harness.manager.resume("user-1"),
    ]);
    assert.equal(harness.calls.length, 2);
    assert.equal(harness.maxActive(), 1);
    assert.equal((await harness.manager.list("user-1")).length, 0);
    assert.equal((await harness.manager.list("user-2")).length, 1);
});

test("offline queue remains local and resumes an interrupted lease on the next online run", async () => {
    const harness = createHarness({ online: false });
    await harness.manager.enqueueBatch([request("user-1")]);
    await harness.manager.resume("user-1");
    assert.equal(harness.calls.length, 0);
    assert.equal((await harness.manager.list("user-1"))[0]?.status, "queued");

    const [queued] = await harness.manager.list("user-1");
    harness.store.items.set(queued.key, {
        ...queued,
        status: "processing",
        leaseId: "dead-tab",
        leaseExpiresAt: 1_000 + DEVICE_OFFLINE_QUEUE_LEASE_MS,
    });
    harness.advance(DEVICE_OFFLINE_QUEUE_LEASE_MS + 1);
    harness.setOnline(true);
    await harness.manager.resume("user-1");

    assert.equal(harness.calls.length, 1);
    assert.equal((await harness.manager.list("user-1")).length, 0);
});

test("auto-liked defaults off, respects its per-device limit, and never crosses owners", async () => {
    const harness = createHarness();
    const autoRequests = Array.from({ length: 30 }, (_, index) => {
        const videoId = `auto-${index}`;
        return request(
            "user-1",
            {
                ...TRACK,
                id: `yt:${videoId}`,
                youtubeVideoId: videoId,
                title: `Auto ${index}`,
            },
            "auto-liked",
        );
    });
    await harness.manager.syncAutoLiked("user-1", autoRequests);
    await harness.manager.resume("user-1");
    assert.equal(harness.calls.length, 0);

    await harness.manager.updateSettings("user-1", {
        autoDownloadLiked: true,
        autoDownloadLikedLimit: 25,
    });
    await harness.manager.syncAutoLiked("user-1", autoRequests);
    assert.equal((await harness.manager.list("user-1")).length, 25);
    assert.equal((await harness.manager.list("user-2")).length, 0);
    await harness.manager.resume("user-1");
    assert.equal(harness.calls.length, 25);
    assert.ok(
        harness.calls.every((input) => input.management === "auto-liked"),
    );
});

test("auto budget evicts only oldest auto-managed ready copies and never manual copies", async () => {
    const harness = createHarness();
    harness.downloads.push(
        readyRecord("user-1", "manual-old", "manual", 1, 900),
        readyRecord("user-1", "auto-old", "auto-liked", 2, 900),
        readyRecord("user-1", "auto-new", "auto-liked", 3, 900),
    );
    await harness.manager.updateSettings("user-1", {
        autoDownloadLiked: true,
        autoDownloadLikedLimit: 1,
        autoDownloadMaxBytes: 1_000,
    });

    await harness.manager.enforceAutoBudget("user-1");

    assert.deepEqual(harness.deleted, ["auto-old"]);
    assert.ok(harness.downloads.some((record) => record.key === "manual-old"));
    assert.ok(harness.downloads.some((record) => record.key === "auto-new"));
});

test("auto budget cannot delete a copy promoted to manual while eviction is pending", async () => {
    let releaseAutoDelete!: () => void;
    const autoDeleteGate = new Promise<void>((resolve) => {
        releaseAutoDelete = resolve;
    });
    const harness = createHarness({ autoDeleteGate });
    harness.downloads.push({
        ...readyRecord("user-1", "auto-race", "auto-liked", 1, 1_500),
        trackIdentity: "youtube:video-1",
        track: TRACK,
    });
    await harness.manager.updateSettings("user-1", {
        autoDownloadLiked: true,
        autoDownloadMaxBytes: 1_000,
    });

    const eviction = harness.manager.enforceAutoBudget("user-1");
    await harness.autoDeleteStarted;
    const manualAction = harness.manager.enqueueBatch([
        request("user-1", TRACK, "manual"),
    ]);
    await manualAction;
    releaseAutoDelete();
    await eviction;

    assert.deepEqual(harness.deleted, []);
    assert.equal(harness.downloads[0]?.management, "manual");
    assert.equal(harness.downloads[0]?.key, "auto-race");
});

test("a manual action queues a fresh copy when budget eviction wins before promotion", async () => {
    let releasePromotion!: () => void;
    const promotionGate = new Promise<void>((resolve) => {
        releasePromotion = resolve;
    });
    const harness = createHarness({ promotionGate });
    harness.downloads.push({
        ...readyRecord("user-1", "delete-wins", "auto-liked", 1, 1_500),
        trackIdentity: "youtube:video-1",
        track: TRACK,
    });
    await harness.manager.updateSettings("user-1", {
        autoDownloadLiked: true,
        autoDownloadMaxBytes: 1_000,
    });

    const manualAction = harness.manager.enqueueBatch([
        request("user-1", TRACK, "manual"),
    ]);
    await harness.promotionStarted;
    assert.deepEqual(await harness.manager.enforceAutoBudget("user-1"), [
        "delete-wins",
    ]);
    releasePromotion();
    const result = await manualAction;

    assert.equal(result.alreadyReady, 0);
    assert.equal(result.queued, 1);
    assert.equal((await harness.manager.list("user-1")).length, 1);
});

test("a queue claimed by a retired auth runtime cannot start a download under replacement credentials", async () => {
    let runtimeGeneration = 1;
    const runtimeController = new AbortController();
    let releaseDownloadList!: () => void;
    const downloadListGate = new Promise<void>((resolve) => {
        releaseDownloadList = resolve;
    });
    const harness = createHarness({
        downloadListGate,
        getAuthRuntimeLease: () => ({
            generation: runtimeGeneration,
            signal: runtimeController.signal,
        }),
        isAuthRuntimeCurrent: (generation) => generation === runtimeGeneration,
    });
    await harness.manager.enqueueBatch([request("user-a")]);

    const running = harness.manager.resume("user-a");
    await harness.downloadListStarted;
    runtimeGeneration = 2;
    releaseDownloadList();
    await running;

    assert.equal(harness.calls.length, 0);
    assert.equal((await harness.manager.list("user-a")).length, 1);
});

test("a stale owner callback cannot enqueue work into a replacement same-owner runtime", async () => {
    let runtimeGeneration = 1;
    const retiredController = new AbortController();
    const freshController = new AbortController();
    let currentLease = {
        generation: runtimeGeneration,
        signal: retiredController.signal,
    };
    const harness = createHarness({
        getAuthRuntimeLease: () => currentLease,
        isAuthRuntimeCurrent: (generation) => generation === runtimeGeneration,
    });
    harness.manager.activateOwner("user-a", currentLease);

    retiredController.abort();
    runtimeGeneration = 2;
    currentLease = {
        generation: runtimeGeneration,
        signal: freshController.signal,
    };

    await assert.rejects(
        harness.manager.enqueueBatch([request("user-a")]),
        /authentication session changed/i,
    );
    assert.equal((await harness.manager.list("user-a")).length, 0);

    harness.manager.activateOwner("user-a", currentLease);
    assert.equal(
        (await harness.manager.enqueueBatch([request("user-a")])).queued,
        1,
    );
});

test("a stale cancellation cannot delete a fresh same-owner queue item after auth replacement", async () => {
    let runtimeGeneration = 1;
    const retiredController = new AbortController();
    const freshController = new AbortController();
    const retiredLease = {
        generation: runtimeGeneration,
        signal: retiredController.signal,
    };
    let currentLease = retiredLease;
    let releaseQueueList!: () => void;
    const queueListGate = new Promise<void>((resolve) => {
        releaseQueueList = resolve;
    });
    const harness = createHarness({
        queueListGate,
        getAuthRuntimeLease: () => currentLease,
        isAuthRuntimeCurrent: (generation) => generation === runtimeGeneration,
    });
    harness.manager.activateOwner("user-a", retiredLease);
    await harness.manager.enqueueBatch([request("user-a")]);

    const staleCancellation = harness.manager.cancelTrack(
        "user-a",
        "youtube:video-1",
        "auto",
    );
    await harness.queueListStarted;
    retiredController.abort();
    harness.manager.retireOwner("user-a", retiredLease);
    runtimeGeneration = 2;
    currentLease = {
        generation: runtimeGeneration,
        signal: freshController.signal,
    };
    harness.manager.activateOwner("user-a", currentLease);
    assert.equal(
        (await harness.manager.enqueueBatch([request("user-a")])).queued,
        1,
    );
    releaseQueueList();

    await assert.rejects(staleCancellation, /authentication session changed/i);
    const freshItems = await harness.manager.list("user-a");
    assert.equal(freshItems.length, 1);
    assert.equal(freshItems[0]?.trackIdentity, "youtube:video-1");
});

test("a stale cancellation cannot delete a same-key download after auth rotates at the delete boundary", async () => {
    let runtimeGeneration = 1;
    const retiredController = new AbortController();
    const freshController = new AbortController();
    const retiredLease = {
        generation: runtimeGeneration,
        signal: retiredController.signal,
    };
    let currentLease = retiredLease;
    let releaseDownloadDelete!: () => void;
    const downloadDeleteGate = new Promise<void>((resolve) => {
        releaseDownloadDelete = resolve;
    });
    const harness = createHarness({
        downloadDeleteGate,
        getAuthRuntimeLease: () => currentLease,
        isAuthRuntimeCurrent: (generation) => generation === runtimeGeneration,
    });
    harness.manager.activateOwner("user-a", retiredLease);
    harness.downloads.push({
        ...readyRecord("user-a", "same-key-copy", "manual", 1),
        trackIdentity: "youtube:video-1",
        track: TRACK,
    });

    const staleCancellation = harness.manager.cancelTrack(
        "user-a",
        "youtube:video-1",
        "auto",
    );
    await harness.downloadDeleteStarted;
    retiredController.abort();
    harness.manager.retireOwner("user-a", retiredLease);
    runtimeGeneration = 2;
    currentLease = {
        generation: runtimeGeneration,
        signal: freshController.signal,
    };
    harness.manager.activateOwner("user-a", currentLease);
    harness.downloads[0] = {
        ...harness.downloads[0],
        updatedAt: 2,
    };
    releaseDownloadDelete();

    await assert.rejects(staleCancellation, /authentication session changed/i);
    assert.equal(harness.downloads.length, 1);
    assert.equal(harness.downloads[0]?.key, "same-key-copy");
    assert.equal(harness.downloads[0]?.updatedAt, 2);
});

test("manual collection action promotes an existing auto copy without redownloading it", async () => {
    const harness = createHarness();
    harness.downloads.push({
        ...readyRecord("user-1", "auto-existing", "auto-liked", 1),
        trackIdentity: "youtube:video-1",
        track: TRACK,
    });
    const staleQueue = await harness.store.upsert({
        ...request("user-1", TRACK, "auto-liked"),
        key: "stale-auto-queue",
        trackIdentity: "youtube:video-1",
        quality: "auto",
        now: 1,
    });
    harness.store.items.set(staleQueue.key, {
        ...staleQueue,
        status: "error",
        errorMessage: "Previous automatic failure",
    });

    const result = await harness.manager.enqueueBatch([request("user-1")]);

    assert.equal(result.alreadyReady, 1);
    assert.deepEqual(harness.promoted, ["auto-existing"]);
    assert.equal((await harness.manager.list("user-1")).length, 0);
    assert.equal(harness.calls.length, 0);
});

test("per-device automation settings are owner-scoped and normalized", async () => {
    const harness = createHarness();
    assert.deepEqual(await harness.manager.getSettings("user-1"), {
        ...DEFAULT_DEVICE_OFFLINE_AUTOMATION_SETTINGS,
        ownerId: "user-1",
    });
    const updated = await harness.manager.updateSettings("user-1", {
        autoDownloadLiked: true,
        autoDownloadLikedLimit: 9_999,
    });
    assert.equal(updated.autoDownloadLiked, true);
    assert.equal(updated.autoDownloadLikedLimit, 200);
    assert.equal(
        (await harness.manager.getSettings("user-2")).autoDownloadLiked,
        false,
    );
});

test("an atomic queue claim ignores other owners, blocks a live lease, and recovers an expired lease", () => {
    const queued = mergeDeviceOfflineQueueItem(null, {
        ...request("user-1"),
        key: "queued",
        trackIdentity: "youtube:video-1",
        quality: "auto",
        now: 1_000,
    });
    const otherOwner = mergeDeviceOfflineQueueItem(null, {
        ...request("user-2"),
        key: "other-owner",
        trackIdentity: "youtube:video-1",
        quality: "auto",
        now: 900,
    });
    const live = {
        ...queued,
        key: "live",
        status: "processing" as const,
        leaseId: "live-tab",
        leaseExpiresAt: 2_001,
    };

    assert.equal(
        claimNextDeviceOfflineQueueItem(
            [queued, otherOwner, live],
            "user-1",
            true,
            "new-tab",
            2_000,
            3_000,
        ),
        null,
    );

    const claimed = claimNextDeviceOfflineQueueItem(
        [queued, otherOwner, { ...live, leaseExpiresAt: 2_000 }],
        "user-1",
        true,
        "new-tab",
        2_000,
        3_000,
    );
    assert.equal(claimed?.key, "queued");
    assert.equal(claimed?.status, "processing");
    assert.equal(claimed?.leaseId, "new-tab");
    assert.equal(claimed?.attempt, 1);
});

test("a long foreground item renews its cross-tab queue lease", async () => {
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
        releaseDownload = resolve;
    });
    const harness = createHarness({
        downloadGate,
        captureHeartbeat: true,
    });
    await harness.manager.enqueueBatch([request("user-1")]);
    const running = harness.manager.resume("user-1");
    for (
        let attempt = 0;
        attempt < 10 && harness.calls.length === 0;
        attempt++
    ) {
        await Promise.resolve();
    }
    const processing = (await harness.manager.list("user-1"))[0];
    assert.equal(processing.status, "processing");
    const oldExpiry = processing.leaseExpiresAt;

    harness.advance(30_000);
    harness.pulseHeartbeat();
    await Promise.resolve();
    await Promise.resolve();
    const renewed = (await harness.manager.list("user-1"))[0];
    assert.ok((renewed.leaseExpiresAt ?? 0) > (oldExpiry ?? 0));

    releaseDownload();
    await running;
    assert.equal((await harness.manager.list("user-1")).length, 0);
});

test("cancelling a processing device track removes its durable queue item and late download", async () => {
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
        releaseDownload = resolve;
    });
    const harness = createHarness({ downloadGate });
    await harness.manager.enqueueBatch([request("user-1")]);

    const processing = harness.manager.resume("user-1");
    while (harness.calls.length === 0) await Promise.resolve();

    await harness.manager.cancelTrack("user-1", "youtube:video-1", "auto");
    assert.equal((await harness.manager.list("user-1")).length, 0);

    releaseDownload();
    await processing;

    assert.equal((await harness.manager.list("user-1")).length, 0);
    assert.equal(harness.downloads.length, 0);
    assert.deepEqual(harness.deleted, ["download-1"]);
});

test("a worker discards a late download when another tab removes its queue lease", async () => {
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
        releaseDownload = resolve;
    });
    const harness = createHarness({ downloadGate });
    await harness.manager.enqueueBatch([request("user-1")]);

    const processing = harness.manager.resume("user-1");
    while (harness.calls.length === 0) await Promise.resolve();

    const [claimed] = await harness.manager.list("user-1");
    assert.equal(claimed.status, "processing");
    assert.equal(await harness.store.deleteIfCurrent(claimed), true);

    releaseDownload();
    await processing;

    assert.equal((await harness.manager.list("user-1")).length, 0);
    assert.equal(harness.downloads.length, 0);
    assert.deepEqual(harness.deleted, ["download-1"]);
});
