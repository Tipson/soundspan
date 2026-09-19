import assert from "node:assert/strict";
import { after, test } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DEVICE_OFFLINE_METADATA_CHANGE_KEY } from "../../features/device-offline/deviceOfflineInvalidation";
import {
    createBrowserDeviceOfflinePlaybackSource,
    getBrowserDeviceOfflineManager,
} from "../../features/device-offline/browserStorage";
import type { DeviceOfflineDownloadRecord } from "../../features/device-offline/types";
import type { DeviceOfflineMetadataStore } from "../../features/device-offline/downloadManager";
import type { DeviceAudioVaultRef } from "../../features/device-offline/vault/types";

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

test("a ready device copy materializes from CacheStorage as a revocable local Blob URL", async () => {
    const matchedUrls: string[] = [];
    const createdBlobs: Blob[] = [];
    const revokedUrls: string[] = [];
    const record = {
        ownerId: "user-1",
        key: "ready-key",
        status: "ready",
        virtualUrl: "/__offline/audio/ready-key",
    } as DeviceOfflineDownloadRecord;

    const source = await createBrowserDeviceOfflinePlaybackSource(record, {
        origin: "https://soundspan.test",
        match: async (url) => {
            matchedUrls.push(url);
            return new Response(Uint8Array.from([1, 2, 3]), {
                headers: { "content-type": "audio/mp4" },
            });
        },
        createObjectUrl: (blob) => {
            createdBlobs.push(blob);
            return "blob:https://soundspan.test/ready-key";
        },
        revokeObjectUrl: (url) => revokedUrls.push(url),
    });

    assert.deepEqual(matchedUrls, [
        "https://soundspan.test/__offline/audio/ready-key",
    ]);
    assert.equal(createdBlobs.length, 1);
    assert.equal(createdBlobs[0].type, "audio/mp4");
    assert.equal(source.url, "blob:https://soundspan.test/ready-key");
    source.revoke();
    source.revoke();
    assert.deepEqual(revokedUrls, ["blob:https://soundspan.test/ready-key"]);
});

test("materializing a missing device cache fails locally instead of returning its network source", async () => {
    const record = {
        ownerId: "user-1",
        key: "missing-key",
        status: "ready",
        virtualUrl: "/__offline/audio/missing-key",
        sourceUrl: "/api/ytmusic/stream-public/video-a",
    } as DeviceOfflineDownloadRecord;
    let created = false;

    await assert.rejects(
        createBrowserDeviceOfflinePlaybackSource(record, {
            origin: "https://soundspan.test",
            match: async () => null,
            createObjectUrl: () => {
                created = true;
                return "blob:unexpected";
            },
            revokeObjectUrl: () => undefined,
        }),
        /больше недоступна/i,
    );
    assert.equal(created, false);
});

test("materializing a truncated ready device copy fails before creating a playback URL", async () => {
    const record = {
        ownerId: "user-1",
        key: "truncated-key",
        status: "ready",
        virtualUrl: "/__offline/audio/truncated-key",
        totalBytes: 6,
    } as DeviceOfflineDownloadRecord;
    let created = false;

    await assert.rejects(
        createBrowserDeviceOfflinePlaybackSource(record, {
            origin: "https://soundspan.test",
            match: async () =>
                new Response(Uint8Array.from([1, 2, 3]), {
                    headers: { "content-length": "6" },
                }),
            createObjectUrl: () => {
                created = true;
                return "blob:unexpected";
            },
            revokeObjectUrl: () => undefined,
        }),
        /неполная/i,
    );
    assert.equal(created, false);
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
    await assert.rejects(
        manager.list("user-1"),
        /обновление базы.*заблокировано/i,
    );
    await Promise.resolve();
    assert.equal(lateCloseCalls, 1);
    assert.deepEqual(await manager.list("user-1"), []);
    assert.equal(openCalls, 2);
    assert.equal(typeof database.onversionchange, "function");
    database.onversionchange?.();
    assert.equal(successfulCloseCalls, 1);
    assert.deepEqual(await manager.list("user-1"), []);
    assert.equal(openCalls, 3);
    database.onversionchange?.();
});

test("IndexedDB replacement protects concurrent manual promotion and the inspected file identity", async (t) => {
    const originalIndexedDb = Object.getOwnPropertyDescriptor(
        globalThis,
        "indexedDB",
    );
    const expected: DeviceOfflineDownloadRecord = {
        key: "old-key",
        ownerId: "user-1",
        trackIdentity: "local:track-1",
        quality: "original",
        virtualUrl: "/__offline/audio/old-key",
        mediaRef: "vault:old" as DeviceAudioVaultRef,
        sourceUrl: "/api/tracks/track-1/stream",
        track: {
            id: "track-1",
            title: "Song",
            artist: { name: "Artist" },
            album: { title: "Album" },
            duration: 180,
        },
        status: "ready",
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 6,
        totalBytes: 6,
        contentType: "audio/mp4",
        persistenceGranted: null,
        management: "auto-liked",
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    };
    const next: DeviceOfflineDownloadRecord = {
        ...expected,
        key: "next-key",
        status: "downloading",
        attempt: 2,
        mediaRef: undefined,
    };
    let current = structuredClone(expected);
    const deleted: string[] = [];
    const written: DeviceOfflineDownloadRecord[] = [];
    const database = {
        onversionchange: null as (() => void) | null,
        close: () => undefined,
        transaction: (_name: string, mode: string) => {
            assert.equal(mode, "readwrite");
            const transaction = {
                oncomplete: null as (() => void) | null,
                objectStore: () => ({
                    index: () => ({
                        get: () => {
                            const request = {
                                result: current,
                                onsuccess: null as (() => void) | null,
                            };
                            queueMicrotask(() => {
                                request.onsuccess?.();
                                transaction.oncomplete?.();
                            });
                            return request;
                        },
                    }),
                    delete: (key: string) => deleted.push(key),
                    put: (record: DeviceOfflineDownloadRecord) =>
                        written.push(structuredClone(record)),
                }),
            };
            return transaction;
        },
    };
    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: {
            open: () => {
                const request = {
                    result: database,
                    onsuccess: null as (() => void) | null,
                };
                queueMicrotask(() => request.onsuccess?.());
                return request;
            },
        },
    });
    t.after(() => {
        database.onversionchange?.();
        if (originalIndexedDb)
            Object.defineProperty(globalThis, "indexedDB", originalIndexedDb);
        else Reflect.deleteProperty(globalThis, "indexedDB");
    });
    // Exercise the production store callback, not an in-memory claim implementation.
    const store = (
        getBrowserDeviceOfflineManager() as unknown as {
            dependencies: { metadataStore: DeviceOfflineMetadataStore };
        }
    ).dependencies.metadataStore;
    for (const changed of [
        { management: "manual" as const },
        { management: undefined },
        { mediaRef: "vault:uninspected" as DeviceAudioVaultRef },
        { totalBytes: 12 },
    ]) {
        current = { ...expected, ...changed };
        assert.equal(
            await store.claimReplacement(expected, next),
            false,
            JSON.stringify(changed),
        );
        assert.deepEqual(deleted, []);
        assert.deepEqual(written, []);
    }
    current = { ...expected, management: "manual" };
    assert.equal(
        await store.claimReplacement(expected, {
            ...next,
            management: "manual",
        }),
        true,
    );
    assert.deepEqual(deleted, [expected.key]);
    assert.equal(written[0].management, "manual");
});
