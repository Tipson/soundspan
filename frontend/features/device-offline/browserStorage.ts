import {
    clampForegroundLeaseClockSkew,
    DeviceOfflineDownloadManager,
    foregroundLeaseDisposition,
    interruptExpiredForegroundRecord,
    matchesDeviceOfflineRecordVersion,
    type DeviceOfflineAudioCache,
    type DeviceOfflineMetadataStore,
} from "./downloadManager";
import {
    abortBrowserBackgroundFetch,
    listBrowserBackgroundFetchIds,
    startBrowserBackgroundFetch,
} from "./platform";
import {
    subscribeToDeviceOfflineMetadataChanges,
    withDeviceOfflineMetadataInvalidation,
} from "./deviceOfflineInvalidation";
import type { DeviceOfflineDownloadRecord } from "./types";

export const DEVICE_OFFLINE_DATABASE_NAME = "soundspan-device-offline-v1";
export const DEVICE_OFFLINE_STORE_NAME = "downloads";
export const DEVICE_OFFLINE_AUDIO_CACHE_NAME = "soundspan-device-audio-v1";

let databasePromise: Promise<IDBDatabase> | null = null;
let manager: DeviceOfflineDownloadManager | null = null;

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

function openDatabase(): Promise<IDBDatabase> {
    if (!databasePromise) {
        const openAttempt = new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(DEVICE_OFFLINE_DATABASE_NAME, 1);
            let settled = false;
            request.onupgradeneeded = () => {
                const database = request.result;
                const store = database.objectStoreNames.contains(
                    DEVICE_OFFLINE_STORE_NAME,
                )
                    ? request.transaction!.objectStore(
                          DEVICE_OFFLINE_STORE_NAME,
                      )
                    : database.createObjectStore(DEVICE_OFFLINE_STORE_NAME, {
                          keyPath: "key",
                      });
                if (!store.indexNames.contains("ownerId")) {
                    store.createIndex("ownerId", "ownerId", {
                        unique: false,
                    });
                }
                if (!store.indexNames.contains("ownerTrackQuality")) {
                    store.createIndex(
                        "ownerTrackQuality",
                        ["ownerId", "trackIdentity", "quality"],
                        { unique: true },
                    );
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
                reject(new Error("Device download database upgrade blocked"));
            };
        });
        const retryableAttempt = openAttempt.catch((error: unknown) => {
            if (databasePromise === retryableAttempt) databasePromise = null;
            throw error;
        });
        databasePromise = retryableAttempt;
    }
    return databasePromise;
}

class BrowserMetadataStore implements DeviceOfflineMetadataStore {
    async listByOwner(ownerId: string): Promise<DeviceOfflineDownloadRecord[]> {
        const database = await openDatabase();
        const transaction = database.transaction(
            DEVICE_OFFLINE_STORE_NAME,
            "readonly",
        );
        const request = transaction
            .objectStore(DEVICE_OFFLINE_STORE_NAME)
            .index("ownerId")
            .getAll(IDBKeyRange.only(ownerId));
        return requestResult(request);
    }

    async getByKey(key: string): Promise<DeviceOfflineDownloadRecord | null> {
        const database = await openDatabase();
        const transaction = database.transaction(
            DEVICE_OFFLINE_STORE_NAME,
            "readonly",
        );
        const result = await requestResult(
            transaction.objectStore(DEVICE_OFFLINE_STORE_NAME).get(key),
        );
        return result ?? null;
    }

    async getByTrackQuality(
        ownerId: string,
        trackIdentity: string,
        quality: string,
    ): Promise<DeviceOfflineDownloadRecord | null> {
        const database = await openDatabase();
        const transaction = database.transaction(
            DEVICE_OFFLINE_STORE_NAME,
            "readonly",
        );
        const result = await requestResult(
            transaction
                .objectStore(DEVICE_OFFLINE_STORE_NAME)
                .index("ownerTrackQuality")
                .get([ownerId, trackIdentity, quality]),
        );
        return result ?? null;
    }

    async put(record: DeviceOfflineDownloadRecord): Promise<void> {
        const database = await openDatabase();
        const transaction = database.transaction(
            DEVICE_OFFLINE_STORE_NAME,
            "readwrite",
        );
        transaction.objectStore(DEVICE_OFFLINE_STORE_NAME).put(record);
        await transactionDone(transaction);
    }

    async claimReplacement(
        expected: DeviceOfflineDownloadRecord | null,
        next: DeviceOfflineDownloadRecord,
    ): Promise<boolean> {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            let claimed = false;
            const transaction = database.transaction(
                DEVICE_OFFLINE_STORE_NAME,
                "readwrite",
            );
            const store = transaction.objectStore(DEVICE_OFFLINE_STORE_NAME);
            const request = store
                .index("ownerTrackQuality")
                .get([next.ownerId, next.trackIdentity, next.quality]);
            request.onsuccess = () => {
                const current = request.result ?? null;
                const canClaim = expected
                    ? matchesDeviceOfflineRecordVersion(current, expected)
                    : current === null;
                if (!canClaim) return;
                claimed = true;
                if (current) store.delete(current.key);
                store.put(next);
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve(claimed);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }

    async putIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
    ): Promise<boolean> {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            let updated = false;
            const transaction = database.transaction(
                DEVICE_OFFLINE_STORE_NAME,
                "readwrite",
            );
            const store = transaction.objectStore(DEVICE_OFFLINE_STORE_NAME);
            const request = store.get(expected.key);
            request.onsuccess = () => {
                if (
                    matchesDeviceOfflineRecordVersion(
                        request.result ?? null,
                        expected,
                    )
                ) {
                    updated = true;
                    store.put(next);
                }
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve(updated);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }

    async interruptForegroundIfLeaseExpired(
        expected: DeviceOfflineDownloadRecord,
        now: number,
    ): Promise<boolean> {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            let interrupted = false;
            const transaction = database.transaction(
                DEVICE_OFFLINE_STORE_NAME,
                "readwrite",
            );
            const store = transaction.objectStore(DEVICE_OFFLINE_STORE_NAME);
            const request = store.get(expected.key);
            request.onsuccess = () => {
                const current = request.result ?? null;
                if (
                    !current ||
                    !matchesDeviceOfflineRecordVersion(current, expected) ||
                    current.status !== "downloading"
                ) {
                    return;
                }
                const disposition = foregroundLeaseDisposition(current, now);
                if (disposition === "live") return;
                if (disposition === "clamp") {
                    store.put(clampForegroundLeaseClockSkew(current, now));
                    return;
                }
                interrupted = true;
                store.put(interruptExpiredForegroundRecord(current, now));
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve(interrupted);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }

    async deleteIfCurrent(
        expected: DeviceOfflineDownloadRecord,
    ): Promise<boolean> {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
            let deleted = false;
            const transaction = database.transaction(
                DEVICE_OFFLINE_STORE_NAME,
                "readwrite",
            );
            const store = transaction.objectStore(DEVICE_OFFLINE_STORE_NAME);
            const request = store.get(expected.key);
            request.onsuccess = () => {
                if (
                    matchesDeviceOfflineRecordVersion(
                        request.result ?? null,
                        expected,
                    )
                ) {
                    deleted = true;
                    store.delete(expected.key);
                }
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve(deleted);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }
}

class BrowserAudioCache implements DeviceOfflineAudioCache {
    private async cache(): Promise<Cache> {
        return caches.open(DEVICE_OFFLINE_AUDIO_CACHE_NAME);
    }

    async put(url: string, response: Response): Promise<void> {
        await (await this.cache()).put(url, response);
    }

    async match(url: string): Promise<Response | null> {
        return (await (await this.cache()).match(url)) ?? null;
    }

    async delete(url: string): Promise<void> {
        await (await this.cache()).delete(url);
    }
}

class BrowserDeviceOfflineDownloadManager extends DeviceOfflineDownloadManager {
    override subscribe(listener: () => void): () => void {
        const unsubscribeLocal = super.subscribe(listener);
        const unsubscribeRemote =
            subscribeToDeviceOfflineMetadataChanges(listener);
        let subscribed = true;
        return () => {
            if (!subscribed) return;
            subscribed = false;
            unsubscribeLocal();
            unsubscribeRemote();
        };
    }
}

function createOpaqueKey(): string {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) =>
        value.toString(16).padStart(2, "0"),
    ).join("");
}

export function getBrowserDeviceOfflineManager(): DeviceOfflineDownloadManager {
    if (typeof window === "undefined") {
        throw new Error("Device downloads are available only in the browser");
    }
    if (manager) return manager;

    const storage = navigator.storage;
    manager = new BrowserDeviceOfflineDownloadManager({
        metadataStore: withDeviceOfflineMetadataInvalidation(
            new BrowserMetadataStore(),
        ),
        audioCache: new BrowserAudioCache(),
        fetch: window.fetch.bind(window),
        now: Date.now,
        createKey: createOpaqueKey,
        origin: window.location.origin,
        requestPersistentStorage: async () => {
            if (!storage?.persist) return null;
            if (await storage.persisted?.()) return true;
            return storage.persist();
        },
        estimateStorage: async () =>
            storage?.estimate ? storage.estimate() : null,
        startBackgroundFetch: startBrowserBackgroundFetch,
        abortBackgroundFetch: abortBrowserBackgroundFetch,
        listActiveBackgroundFetches: listBrowserBackgroundFetchIds,
        scheduleLeaseHeartbeat: (callback, intervalMs) =>
            window.setInterval(callback, intervalMs),
        cancelLeaseHeartbeat: (handle) =>
            window.clearInterval(handle as number),
        scheduleLeaseExpiryCheck: (callback, delayMs) =>
            window.setTimeout(callback, delayMs),
        cancelLeaseExpiryCheck: (handle) =>
            window.clearTimeout(handle as number),
    });
    return manager;
}
