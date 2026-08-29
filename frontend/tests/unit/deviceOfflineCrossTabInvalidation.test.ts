import assert from "node:assert/strict";
import test from "node:test";
import {
    DEVICE_OFFLINE_METADATA_CHANGE_KEY,
    isDeviceOfflineMetadataChangeStorageEvent,
    publishDeviceOfflineMetadataChange,
    requiresDeviceOfflineCrossTabRefresh,
    subscribeToDeviceOfflineMetadataChanges,
    withDeviceOfflineMetadataInvalidation,
} from "../../features/device-offline/deviceOfflineInvalidation";
import type { DeviceOfflineMetadataStore } from "../../features/device-offline/downloadManager";
import type { DeviceOfflineDownloadRecord } from "../../features/device-offline/types";

const RECORD: DeviceOfflineDownloadRecord = {
    key: "opaque-key-1",
    ownerId: "user-1",
    trackIdentity: "youtube:video-1",
    quality: "auto",
    virtualUrl: "/__offline/audio/opaque-key-1",
    sourceUrl: "/api/ytmusic/stream-public/video-1",
    track: {
        id: "video-1",
        title: "Private title",
        artist: { name: "Private artist" },
        album: { title: "Private album" },
        duration: 180,
        streamSource: "youtube",
        youtubeVideoId: "video-1",
    },
    status: "downloading",
    transferMode: "foreground",
    backgroundFetchId: null,
    foregroundLeaseId: "lease-1",
    foregroundLeaseExpiresAt: 30_000,
    bytesReceived: 0,
    totalBytes: null,
    contentType: null,
    persistenceGranted: true,
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    errorCode: null,
    errorMessage: null,
};

test("cross-tab device-download notifications are opaque and recognizable", () => {
    const values = new Map<string, string>();

    publishDeviceOfflineMetadataChange(
        {
            setItem: (key: string, value: string) => values.set(key, value),
        },
        () => "opaque-generation-7",
    );

    const signal = values.get(DEVICE_OFFLINE_METADATA_CHANGE_KEY);
    assert.equal(signal, "opaque-generation-7");
    assert.doesNotMatch(
        JSON.stringify([...values]),
        /user-1|Private title|Private artist|video-1/,
    );
    assert.equal(
        isDeviceOfflineMetadataChangeStorageEvent({
            key: DEVICE_OFFLINE_METADATA_CHANGE_KEY,
        }),
        true,
    );
    assert.equal(
        isDeviceOfflineMetadataChangeStorageEvent({ key: "auth_token" }),
        false,
    );
});

test("cross-tab subscriptions filter unrelated events and remove their listener", () => {
    const listeners = new Set<(event: StorageEvent) => void>();
    const target = {
        addEventListener: (
            _type: "storage",
            listener: (event: StorageEvent) => void,
        ) => listeners.add(listener),
        removeEventListener: (
            _type: "storage",
            listener: (event: StorageEvent) => void,
        ) => listeners.delete(listener),
    };
    let notifications = 0;
    const unsubscribe = subscribeToDeviceOfflineMetadataChanges(() => {
        notifications += 1;
    }, target);

    for (const listener of listeners) {
        listener({ key: "unrelated" } as StorageEvent);
        listener({
            key: DEVICE_OFFLINE_METADATA_CHANGE_KEY,
        } as StorageEvent);
    }
    assert.equal(notifications, 1);

    unsubscribe();
    unsubscribe();
    assert.equal(listeners.size, 0);
});

test("lease-only renewals stay local while playback-visible transitions invalidate other tabs", () => {
    assert.equal(
        requiresDeviceOfflineCrossTabRefresh(RECORD, {
            ...RECORD,
            foregroundLeaseExpiresAt: 60_000,
            updatedAt: 2,
        }),
        false,
    );
    assert.equal(
        requiresDeviceOfflineCrossTabRefresh(RECORD, {
            ...RECORD,
            status: "ready",
            bytesReceived: 1_024,
            totalBytes: 1_024,
            foregroundLeaseId: null,
            foregroundLeaseExpiresAt: null,
            updatedAt: 3,
        }),
        true,
    );
    assert.equal(
        requiresDeviceOfflineCrossTabRefresh(RECORD, {
            ...RECORD,
            status: "interrupted",
            errorCode: "interrupted",
            errorMessage: "Interrupted",
            updatedAt: 4,
        }),
        true,
    );
    assert.equal(
        requiresDeviceOfflineCrossTabRefresh(RECORD, {
            ...RECORD,
            management: "manual",
            updatedAt: 5,
        }),
        true,
    );
});

test("successful metadata transitions publish invalidation while failed CAS and lease renewal stay quiet", async () => {
    let updateSucceeds = true;
    let claimSucceeds = false;
    let interruptSucceeds = false;
    let deleteSucceeds = false;
    let automaticDeleteSucceeds = false;
    const delegate: DeviceOfflineMetadataStore = {
        listByOwner: async () => [RECORD],
        getByKey: async () => RECORD,
        getByTrackQuality: async () => RECORD,
        put: async () => undefined,
        claimReplacement: async () => claimSucceeds,
        putIfCurrent: async () => updateSucceeds,
        interruptForegroundIfLeaseExpired: async () => interruptSucceeds,
        deleteIfCurrent: async () => deleteSucceeds,
        deleteAutoManagedIfCurrent: async () => automaticDeleteSucceeds,
    };
    const publications: unknown[][] = [];
    const store = withDeviceOfflineMetadataInvalidation(delegate, (...args) =>
        publications.push(args),
    );

    await store.put(RECORD);
    assert.deepEqual(publications, [[]]);

    publications.length = 0;
    assert.equal(
        await store.putIfCurrent(RECORD, {
            ...RECORD,
            foregroundLeaseExpiresAt: 60_000,
            updatedAt: 2,
        }),
        true,
    );
    assert.deepEqual(publications, []);

    assert.equal(
        await store.putIfCurrent(RECORD, { ...RECORD, status: "ready" }),
        true,
    );
    assert.deepEqual(publications, [[]]);

    publications.length = 0;
    updateSucceeds = false;
    assert.equal(
        await store.putIfCurrent(RECORD, { ...RECORD, status: "error" }),
        false,
    );
    assert.deepEqual(publications, []);

    assert.equal(await store.claimReplacement(null, RECORD), false);
    claimSucceeds = true;
    assert.equal(await store.claimReplacement(null, RECORD), true);
    assert.deepEqual(publications, [[]]);

    publications.length = 0;
    assert.equal(
        await store.interruptForegroundIfLeaseExpired(RECORD, 99),
        false,
    );
    interruptSucceeds = true;
    assert.equal(
        await store.interruptForegroundIfLeaseExpired(RECORD, 99),
        true,
    );
    assert.deepEqual(publications, [[]]);

    publications.length = 0;
    assert.equal(await store.deleteIfCurrent(RECORD), false);
    deleteSucceeds = true;
    assert.equal(await store.deleteIfCurrent(RECORD), true);
    assert.deepEqual(publications, [[]]);

    publications.length = 0;
    assert.equal(await store.deleteAutoManagedIfCurrent(RECORD), false);
    automaticDeleteSucceeds = true;
    assert.equal(await store.deleteAutoManagedIfCurrent(RECORD), true);
    assert.deepEqual(publications, [[]]);
});
