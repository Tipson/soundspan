import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DEVICE_OFFLINE_METADATA_CHANGE_KEY } from "../../features/device-offline/deviceOfflineInvalidation";
import { getBrowserDeviceOfflineManager } from "../../features/device-offline/browserStorage";

GlobalRegistrator.register({ url: "https://soundspan.test/" });

after(async () => {
    await GlobalRegistrator.unregister();
});

test("the browser manager forwards cross-tab invalidations and cleans up on unsubscribe", () => {
    const manager = getBrowserDeviceOfflineManager();
    let notifications = 0;
    const unsubscribe = manager.subscribe(() => {
        notifications += 1;
    });

    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    window.dispatchEvent(
        new StorageEvent("storage", {
            key: DEVICE_OFFLINE_METADATA_CHANGE_KEY,
            newValue: "opaque-generation",
        }),
    );
    assert.equal(notifications, 1);

    unsubscribe();
    window.dispatchEvent(
        new StorageEvent("storage", {
            key: DEVICE_OFFLINE_METADATA_CHANGE_KEY,
            newValue: "another-generation",
        }),
    );
    assert.equal(notifications, 1);
});

test("a blocked IndexedDB open closes a late handle and successful handles close on version changes", async (t) => {
    const originalIndexedDb = Object.getOwnPropertyDescriptor(
        globalThis,
        "indexedDB",
    );
    const originalKeyRange = Object.getOwnPropertyDescriptor(
        globalThis,
        "IDBKeyRange",
    );
    t.after(() => {
        if (originalIndexedDb) {
            Object.defineProperty(globalThis, "indexedDB", originalIndexedDb);
        } else {
            Reflect.deleteProperty(globalThis, "indexedDB");
        }
        if (originalKeyRange) {
            Object.defineProperty(globalThis, "IDBKeyRange", originalKeyRange);
        } else {
            Reflect.deleteProperty(globalThis, "IDBKeyRange");
        }
    });

    let openCalls = 0;
    let lateCloseCalls = 0;
    let successfulCloseCalls = 0;
    const database = {
        onversionchange: null as (() => void) | null,
        close: () => {
            successfulCloseCalls += 1;
        },
        transaction: () => ({
            objectStore: () => ({
                index: () => ({
                    getAll: () => {
                        const request = {
                            result: [] as unknown[],
                            error: null,
                            onsuccess: null as (() => void) | null,
                            onerror: null as (() => void) | null,
                        };
                        queueMicrotask(() => request.onsuccess?.());
                        return request;
                    },
                }),
            }),
        }),
    };
    const lateDatabase = {
        ...database,
        close: () => {
            lateCloseCalls += 1;
        },
    };
    Object.defineProperty(globalThis, "IDBKeyRange", {
        configurable: true,
        value: { only: (value: string) => value },
    });
    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: {
            open: () => {
                openCalls += 1;
                const request = {
                    result: openCalls === 1 ? lateDatabase : database,
                    error: null as Error | null,
                    onupgradeneeded: null as (() => void) | null,
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null,
                    onblocked: null as (() => void) | null,
                };
                queueMicrotask(() => {
                    if (openCalls === 1) {
                        request.onblocked?.();
                        queueMicrotask(() => request.onsuccess?.());
                    } else {
                        request.onsuccess?.();
                    }
                });
                return request;
            },
        },
    });

    const manager = getBrowserDeviceOfflineManager();
    await assert.rejects(manager.list("user-1"), /upgrade blocked/);
    await Promise.resolve();
    assert.equal(lateCloseCalls, 1);
    assert.deepEqual(await manager.list("user-1"), []);
    assert.equal(openCalls, 2);
    assert.equal(typeof database.onversionchange, "function");
    database.onversionchange?.();
    assert.equal(successfulCloseCalls, 1);
    assert.deepEqual(await manager.list("user-1"), []);
    assert.equal(openCalls, 3);
});
