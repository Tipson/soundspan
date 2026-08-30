import assert from "node:assert/strict";
import test from "node:test";
import { getBrowserDeviceOfflineQueueManager } from "../../features/device-offline/browserQueueStorage";
import type { DeviceOfflineDownloadManager } from "../../features/device-offline/downloadManager";
import { advanceAuthRuntimeGeneration } from "../../lib/auth-runtime-generation";

test("browser settings storage rechecks authorization inside the IndexedDB transaction", async () => {
    const originalIndexedDb = Object.getOwnPropertyDescriptor(
        globalThis,
        "indexedDB",
    );
    const originalWindow = Object.getOwnPropertyDescriptor(
        globalThis,
        "window",
    );
    const writtenSettings: unknown[] = [];
    let rotated = false;

    const createTransaction = (mode: IDBTransactionMode) => {
        const transaction = {
            error: null,
            oncomplete: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onabort: null as (() => void) | null,
            objectStore: () => {
                if (mode === "readwrite" && !rotated) {
                    rotated = true;
                    advanceAuthRuntimeGeneration();
                }
                return {
                    get: () => {
                        const request = {
                            result: undefined,
                            error: null,
                            onsuccess: null as (() => void) | null,
                            onerror: null as (() => void) | null,
                        };
                        queueMicrotask(() => request.onsuccess?.());
                        return request as unknown as IDBRequest<unknown>;
                    },
                    put: (value: unknown) => {
                        writtenSettings.push(value);
                        return {} as IDBRequest<IDBValidKey>;
                    },
                };
            },
        };
        setTimeout(() => transaction.oncomplete?.(), 0);
        return transaction as unknown as IDBTransaction;
    };
    const database = {
        onversionchange: null,
        close: () => undefined,
        transaction: (_name: string, mode: IDBTransactionMode) =>
            createTransaction(mode),
    } as unknown as IDBDatabase;
    const indexedDb = {
        open: () => {
            const request = {
                result: database,
                error: null,
                transaction: null,
                onsuccess: null as (() => void) | null,
                onerror: null as (() => void) | null,
                onblocked: null as (() => void) | null,
                onupgradeneeded: null as (() => void) | null,
            };
            queueMicrotask(() => request.onsuccess?.());
            return request as unknown as IDBOpenDBRequest;
        },
    } as unknown as IDBFactory;

    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: indexedDb,
    });
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            localStorage: { setItem: () => undefined },
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            setInterval,
            clearInterval,
        },
    });

    try {
        const manager = getBrowserDeviceOfflineQueueManager(
            {} as DeviceOfflineDownloadManager,
        );
        await assert.rejects(
            manager.updateSettings("user-a", {
                autoDownloadLiked: true,
            }),
            /сеанс авторизации изменился/i,
        );
        assert.equal(rotated, true);
        assert.deepEqual(writtenSettings, []);
    } finally {
        if (originalIndexedDb) {
            Object.defineProperty(globalThis, "indexedDB", originalIndexedDb);
        } else {
            Reflect.deleteProperty(globalThis, "indexedDB");
        }
        if (originalWindow) {
            Object.defineProperty(globalThis, "window", originalWindow);
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }
    }
});
