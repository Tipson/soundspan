import { getBrowserDeviceOfflineManager } from "./browserStorage";
import {
    getAuthRuntimeLease,
    isCurrentAuthRuntime,
} from "@/lib/auth-runtime-generation";
import type { DeviceOfflineDownloadManager } from "./downloadManager";
import {
    DeviceOfflineQueueManager,
    claimNextDeviceOfflineQueueItem,
    matchesDeviceOfflineQueueVersion,
    mergeDeviceOfflineQueueItem,
    type DeviceOfflineAutomationSettings,
    type DeviceOfflineQueueItem,
    type DeviceOfflineQueueStore,
    type DeviceOfflineQueueUpsert,
} from "./offlineQueue";

export const DEVICE_OFFLINE_AUTOMATION_DATABASE_NAME =
    "soundspan-device-offline-automation-v1";
export const DEVICE_OFFLINE_QUEUE_STORE_NAME = "queue";
export const DEVICE_OFFLINE_SETTINGS_STORE_NAME = "settings";
export const DEVICE_OFFLINE_QUEUE_CHANGE_KEY =
    "soundspan_device_offline_queue_change_v1";

let databasePromise: Promise<IDBDatabase> | null = null;
let queueManager: DeviceOfflineQueueManager | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

function openAutomationDatabase(): Promise<IDBDatabase> {
    if (databasePromise) return databasePromise;

    const attempt = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(
            DEVICE_OFFLINE_AUTOMATION_DATABASE_NAME,
            1,
        );
        let settled = false;
        request.onupgradeneeded = () => {
            const database = request.result;
            const queue = database.objectStoreNames.contains(
                DEVICE_OFFLINE_QUEUE_STORE_NAME,
            )
                ? request.transaction!.objectStore(
                      DEVICE_OFFLINE_QUEUE_STORE_NAME,
                  )
                : database.createObjectStore(DEVICE_OFFLINE_QUEUE_STORE_NAME, {
                      keyPath: "key",
                  });
            if (!queue.indexNames.contains("ownerId")) {
                queue.createIndex("ownerId", "ownerId", { unique: false });
            }
            if (!queue.indexNames.contains("ownerTrackQuality")) {
                queue.createIndex(
                    "ownerTrackQuality",
                    ["ownerId", "trackIdentity", "quality"],
                    { unique: true },
                );
            }
            if (
                !database.objectStoreNames.contains(
                    DEVICE_OFFLINE_SETTINGS_STORE_NAME,
                )
            ) {
                database.createObjectStore(DEVICE_OFFLINE_SETTINGS_STORE_NAME, {
                    keyPath: "ownerId",
                });
            }
        };
        request.onsuccess = () => {
            const database = request.result;
            if (settled) {
                database.close();
                return;
            }
            settled = true;
            database.onversionchange = () => {
                database.close();
                databasePromise = null;
            };
            resolve(database);
        };
        request.onerror = () => {
            if (settled) return;
            settled = true;
            reject(request.error);
        };
        request.onblocked = () => {
            if (settled) return;
            settled = true;
            reject(new Error("Обновление базы офлайн-загрузок заблокировано"));
        };
    });
    const retryableAttempt = attempt.catch((error: unknown) => {
        if (databasePromise === retryableAttempt) databasePromise = null;
        throw error;
    });
    databasePromise = retryableAttempt;
    return retryableAttempt;
}

function createOpaqueSignal(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function publishQueueChange(): void {
    try {
        window.localStorage.setItem(
            DEVICE_OFFLINE_QUEUE_CHANGE_KEY,
            createOpaqueSignal(),
        );
    } catch {
        // IndexedDB remains authoritative when cross-tab signals are blocked.
    }
}

function subscribeToQueueChanges(listener: () => void): () => void {
    const handleStorage = (event: StorageEvent) => {
        if (event.key === DEVICE_OFFLINE_QUEUE_CHANGE_KEY) listener();
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
}

class BrowserDeviceOfflineQueueStore implements DeviceOfflineQueueStore {
    async listByOwner(ownerId: string): Promise<DeviceOfflineQueueItem[]> {
        const database = await openAutomationDatabase();
        const transaction = database.transaction(
            DEVICE_OFFLINE_QUEUE_STORE_NAME,
            "readonly",
        );
        return requestResult(
            transaction
                .objectStore(DEVICE_OFFLINE_QUEUE_STORE_NAME)
                .index("ownerId")
                .getAll(IDBKeyRange.only(ownerId)),
        );
    }

    async getByKey(key: string): Promise<DeviceOfflineQueueItem | null> {
        const database = await openAutomationDatabase();
        const transaction = database.transaction(
            DEVICE_OFFLINE_QUEUE_STORE_NAME,
            "readonly",
        );
        const result = await requestResult(
            transaction.objectStore(DEVICE_OFFLINE_QUEUE_STORE_NAME).get(key),
        );
        return result ?? null;
    }

    async upsert(
        input: DeviceOfflineQueueUpsert,
        isAuthorized?: () => boolean,
    ): Promise<DeviceOfflineQueueItem> {
        const database = await openAutomationDatabase();
        let next: DeviceOfflineQueueItem | null = null;
        const transaction = database.transaction(
            DEVICE_OFFLINE_QUEUE_STORE_NAME,
            "readwrite",
        );
        const store = transaction.objectStore(DEVICE_OFFLINE_QUEUE_STORE_NAME);
        const request = store
            .index("ownerTrackQuality")
            .get([input.ownerId, input.trackIdentity, input.quality]);
        request.onsuccess = () => {
            if (isAuthorized && !isAuthorized()) return;
            next = mergeDeviceOfflineQueueItem(request.result ?? null, input);
            store.put(next);
        };
        request.onerror = () => transaction.abort();
        await transactionDone(transaction);
        if (!next)
            throw new Error("Не удалось обновить очередь офлайн-загрузок");
        publishQueueChange();
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
        const database = await openAutomationDatabase();
        let claimed: DeviceOfflineQueueItem | null = null;
        const transaction = database.transaction(
            DEVICE_OFFLINE_QUEUE_STORE_NAME,
            "readwrite",
        );
        const store = transaction.objectStore(DEVICE_OFFLINE_QUEUE_STORE_NAME);
        const request = store
            .index("ownerId")
            .getAll(IDBKeyRange.only(ownerId));
        request.onsuccess = () => {
            if (isAuthorized && !isAuthorized()) return;
            claimed = claimNextDeviceOfflineQueueItem(
                request.result,
                ownerId,
                allowAuto,
                leaseId,
                now,
                leaseExpiresAt,
            );
            if (claimed) store.put(claimed);
        };
        request.onerror = () => transaction.abort();
        await transactionDone(transaction);
        if (claimed) publishQueueChange();
        return claimed;
    }

    async putIfCurrent(
        expected: DeviceOfflineQueueItem,
        next: DeviceOfflineQueueItem,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        const database = await openAutomationDatabase();
        let updated = false;
        const transaction = database.transaction(
            DEVICE_OFFLINE_QUEUE_STORE_NAME,
            "readwrite",
        );
        const store = transaction.objectStore(DEVICE_OFFLINE_QUEUE_STORE_NAME);
        const request = store.get(expected.key);
        request.onsuccess = () => {
            if (isAuthorized && !isAuthorized()) return;
            if (
                matchesDeviceOfflineQueueVersion(
                    request.result ?? null,
                    expected,
                )
            ) {
                updated = true;
                store.put(next);
            }
        };
        request.onerror = () => transaction.abort();
        await transactionDone(transaction);
        if (updated) publishQueueChange();
        return updated;
    }

    async deleteIfCurrent(
        expected: DeviceOfflineQueueItem,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        const database = await openAutomationDatabase();
        let deleted = false;
        const transaction = database.transaction(
            DEVICE_OFFLINE_QUEUE_STORE_NAME,
            "readwrite",
        );
        const store = transaction.objectStore(DEVICE_OFFLINE_QUEUE_STORE_NAME);
        const request = store.get(expected.key);
        request.onsuccess = () => {
            if (isAuthorized && !isAuthorized()) return;
            if (
                matchesDeviceOfflineQueueVersion(
                    request.result ?? null,
                    expected,
                )
            ) {
                deleted = true;
                store.delete(expected.key);
            }
        };
        request.onerror = () => transaction.abort();
        await transactionDone(transaction);
        if (deleted) publishQueueChange();
        return deleted;
    }

    async recoverExpired(
        ownerId: string,
        now: number,
        isAuthorized?: () => boolean,
    ): Promise<void> {
        const database = await openAutomationDatabase();
        let recovered = false;
        const transaction = database.transaction(
            DEVICE_OFFLINE_QUEUE_STORE_NAME,
            "readwrite",
        );
        const store = transaction.objectStore(DEVICE_OFFLINE_QUEUE_STORE_NAME);
        const request = store
            .index("ownerId")
            .getAll(IDBKeyRange.only(ownerId));
        request.onsuccess = () => {
            if (isAuthorized && !isAuthorized()) return;
            for (const item of request.result) {
                if (
                    item.status === "processing" &&
                    (item.leaseExpiresAt ?? 0) <= now
                ) {
                    recovered = true;
                    store.put({
                        ...item,
                        status: "interrupted",
                        leaseId: null,
                        leaseExpiresAt: null,
                        updatedAt: now,
                        errorMessage:
                            "Загрузка была прервана и готова к продолжению.",
                    });
                }
            }
        };
        request.onerror = () => transaction.abort();
        await transactionDone(transaction);
        if (recovered) publishQueueChange();
    }

    async renewLease(
        ownerId: string,
        key: string,
        leaseId: string,
        now: number,
        leaseExpiresAt: number,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        const database = await openAutomationDatabase();
        let renewed = false;
        const transaction = database.transaction(
            DEVICE_OFFLINE_QUEUE_STORE_NAME,
            "readwrite",
        );
        const store = transaction.objectStore(DEVICE_OFFLINE_QUEUE_STORE_NAME);
        const request = store.get(key);
        request.onsuccess = () => {
            if (isAuthorized && !isAuthorized()) return;
            const current = request.result as
                | DeviceOfflineQueueItem
                | undefined;
            if (
                !current ||
                current.ownerId !== ownerId ||
                current.status !== "processing" ||
                current.leaseId !== leaseId
            ) {
                return;
            }
            renewed = true;
            store.put({
                ...current,
                leaseExpiresAt,
                updatedAt: now,
            });
        };
        request.onerror = () => transaction.abort();
        await transactionDone(transaction);
        return renewed;
    }

    async getSettings(
        ownerId: string,
    ): Promise<DeviceOfflineAutomationSettings | null> {
        const database = await openAutomationDatabase();
        const transaction = database.transaction(
            DEVICE_OFFLINE_SETTINGS_STORE_NAME,
            "readonly",
        );
        const result = await requestResult(
            transaction
                .objectStore(DEVICE_OFFLINE_SETTINGS_STORE_NAME)
                .get(ownerId),
        );
        return result ?? null;
    }

    async putSettings(
        settings: DeviceOfflineAutomationSettings,
        isAuthorized?: () => boolean,
    ): Promise<void> {
        if (isAuthorized && !isAuthorized()) return;
        const database = await openAutomationDatabase();
        if (isAuthorized && !isAuthorized()) return;
        let updated = false;
        const transaction = database.transaction(
            DEVICE_OFFLINE_SETTINGS_STORE_NAME,
            "readwrite",
        );
        const store = transaction.objectStore(
            DEVICE_OFFLINE_SETTINGS_STORE_NAME,
        );
        const request = store.get(settings.ownerId);
        request.onsuccess = () => {
            if (isAuthorized && !isAuthorized()) return;
            store.put(settings);
            updated = true;
        };
        request.onerror = () => transaction.abort();
        await transactionDone(transaction);
        if (updated) publishQueueChange();
    }
}

class BrowserDeviceOfflineQueueManager extends DeviceOfflineQueueManager {
    override subscribe(listener: () => void): () => void {
        const unsubscribeLocal = super.subscribe(listener);
        const unsubscribeRemote = subscribeToQueueChanges(listener);
        return () => {
            unsubscribeLocal();
            unsubscribeRemote();
        };
    }
}

function createOpaqueKey(): string {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) =>
        value.toString(16).padStart(2, "0"),
    ).join("");
}

/** Get the browser-local serial queue shared by the mounted PWA providers. */
export function getBrowserDeviceOfflineQueueManager(
    downloads: DeviceOfflineDownloadManager = getBrowserDeviceOfflineManager(),
): DeviceOfflineQueueManager {
    if (typeof window === "undefined") {
        throw new Error("Очередь офлайн-загрузок доступна только в браузере");
    }
    if (queueManager) return queueManager;

    queueManager = new BrowserDeviceOfflineQueueManager({
        store: new BrowserDeviceOfflineQueueStore(),
        downloads,
        now: Date.now,
        createKey: createOpaqueKey,
        createLeaseId: createOpaqueKey,
        isOnline: () => navigator.onLine !== false,
        scheduleLeaseHeartbeat: (callback, intervalMs) =>
            window.setInterval(callback, intervalMs),
        cancelLeaseHeartbeat: (handle) =>
            window.clearInterval(handle as number),
        getAuthRuntimeLease,
        isAuthRuntimeCurrent: isCurrentAuthRuntime,
    });
    return queueManager;
}
