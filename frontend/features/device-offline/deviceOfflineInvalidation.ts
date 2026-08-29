import type { DeviceOfflineMetadataStore } from "./downloadManager";
import type { DeviceOfflineDownloadRecord } from "./types";

/** Opaque localStorage key used only to invalidate other same-origin tabs. */
export const DEVICE_OFFLINE_METADATA_CHANGE_KEY =
    "soundspan_device_offline_metadata_change_v1";

type DeviceOfflineSignalStorage = Pick<Storage, "setItem">;

/** Minimal storage-event surface used for cross-tab metadata invalidation. */
export interface DeviceOfflineStorageEventTarget {
    addEventListener(
        type: "storage",
        listener: (event: StorageEvent) => void,
    ): void;
    removeEventListener(
        type: "storage",
        listener: (event: StorageEvent) => void,
    ): void;
}

function createOpaqueMetadataSignal(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function defaultStorage(): DeviceOfflineSignalStorage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function defaultEventTarget(): DeviceOfflineStorageEventTarget | null {
    if (typeof window === "undefined") return null;
    return {
        addEventListener: (_type, listener) =>
            window.addEventListener("storage", listener),
        removeEventListener: (_type, listener) =>
            window.removeEventListener("storage", listener),
    };
}

/** Notify other same-origin tabs without exposing an owner or track record. */
export function publishDeviceOfflineMetadataChange(
    storage: DeviceOfflineSignalStorage | null = defaultStorage(),
    createSignal: () => string = createOpaqueMetadataSignal,
): void {
    try {
        storage?.setItem(DEVICE_OFFLINE_METADATA_CHANGE_KEY, createSignal());
    } catch {
        // Cross-tab signaling is best effort in restricted storage contexts.
    }
}

/** Narrow a storage event to the opaque device-download generation signal. */
export function isDeviceOfflineMetadataChangeStorageEvent(event: {
    key: string | null;
}): boolean {
    return event.key === DEVICE_OFFLINE_METADATA_CHANGE_KEY;
}

/**
 * Subscribe to remote-tab metadata invalidations. The callback receives no
 * owner or track data and must reload the active owner's IndexedDB view.
 */
export function subscribeToDeviceOfflineMetadataChanges(
    listener: () => void,
    target: DeviceOfflineStorageEventTarget | null = defaultEventTarget(),
): () => void {
    if (!target) return () => undefined;
    const handleStorage = (event: StorageEvent) => {
        if (isDeviceOfflineMetadataChangeStorageEvent(event)) listener();
    };
    target.addEventListener("storage", handleStorage);
    let subscribed = true;
    return () => {
        if (!subscribed) return;
        subscribed = false;
        target.removeEventListener("storage", handleStorage);
    };
}

/** Ignore lease bookkeeping while recognizing playback-visible record changes. */
export function requiresDeviceOfflineCrossTabRefresh(
    previous: DeviceOfflineDownloadRecord,
    next: DeviceOfflineDownloadRecord,
): boolean {
    return (
        previous.key !== next.key ||
        previous.ownerId !== next.ownerId ||
        previous.trackIdentity !== next.trackIdentity ||
        previous.quality !== next.quality ||
        previous.virtualUrl !== next.virtualUrl ||
        previous.sourceUrl !== next.sourceUrl ||
        previous.status !== next.status ||
        previous.transferMode !== next.transferMode ||
        previous.backgroundFetchId !== next.backgroundFetchId ||
        previous.bytesReceived !== next.bytesReceived ||
        previous.totalBytes !== next.totalBytes ||
        previous.contentType !== next.contentType ||
        previous.mediaRef !== next.mediaRef ||
        previous.integrityVersion !== next.integrityVersion ||
        previous.persistenceGranted !== next.persistenceGranted ||
        previous.management !== next.management ||
        previous.attempt !== next.attempt ||
        previous.createdAt !== next.createdAt ||
        previous.errorCode !== next.errorCode ||
        previous.errorMessage !== next.errorMessage
    );
}

class InvalidatingDeviceOfflineMetadataStore implements DeviceOfflineMetadataStore {
    constructor(
        private readonly delegate: DeviceOfflineMetadataStore,
        private readonly publish: () => void,
    ) {}

    listByOwner(ownerId: string): Promise<DeviceOfflineDownloadRecord[]> {
        return this.delegate.listByOwner(ownerId);
    }

    getByKey(key: string): Promise<DeviceOfflineDownloadRecord | null> {
        return this.delegate.getByKey(key);
    }

    getByTrackQuality(
        ownerId: string,
        trackIdentity: string,
        quality: string,
    ): Promise<DeviceOfflineDownloadRecord | null> {
        return this.delegate.getByTrackQuality(ownerId, trackIdentity, quality);
    }

    async put(record: DeviceOfflineDownloadRecord): Promise<void> {
        await this.delegate.put(record);
        this.publish();
    }

    async claimReplacement(
        expected: DeviceOfflineDownloadRecord | null,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        const claimed = await this.delegate.claimReplacement(
            expected,
            next,
            isAuthorized,
        );
        if (claimed) this.publish();
        return claimed;
    }

    async putIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        const updated = await this.delegate.putIfCurrent(
            expected,
            next,
            isAuthorized,
        );
        if (updated && requiresDeviceOfflineCrossTabRefresh(expected, next)) {
            this.publish();
        }
        return updated;
    }

    async putAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        const updated = await this.delegate.putAutoManagedIfCurrent(
            expected,
            next,
            isAuthorized,
        );
        if (updated && requiresDeviceOfflineCrossTabRefresh(expected, next)) {
            this.publish();
        }
        return updated;
    }

    async interruptForegroundIfLeaseExpired(
        expected: DeviceOfflineDownloadRecord,
        now: number,
    ): Promise<boolean> {
        const interrupted =
            await this.delegate.interruptForegroundIfLeaseExpired(
                expected,
                now,
            );
        if (interrupted) this.publish();
        return interrupted;
    }

    async deleteIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        const deleted = await this.delegate.deleteIfCurrent(
            expected,
            isAuthorized,
        );
        if (deleted) this.publish();
        return deleted;
    }

    async deleteAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        const deleted = await this.delegate.deleteAutoManagedIfCurrent(
            expected,
            isAuthorized,
        );
        if (deleted) this.publish();
        return deleted;
    }
}

/** Decorate browser metadata writes with opaque, meaningful cross-tab signals. */
export function withDeviceOfflineMetadataInvalidation(
    delegate: DeviceOfflineMetadataStore,
    publish: () => void = publishDeviceOfflineMetadataChange,
): DeviceOfflineMetadataStore {
    return new InvalidatingDeviceOfflineMetadataStore(delegate, publish);
}
