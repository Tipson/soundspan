import {
    normalizeDeviceOfflineQuality,
    resolveDeviceOfflineTrackIdentity,
} from "./trackIdentity";
import type {
    DeviceOfflineDownloadInput,
    DeviceOfflineDownloadRecord,
    DeviceOfflineManagement,
    DeviceOfflineTrack,
} from "./types";
import type { AuthRuntimeLease } from "@/lib/auth-runtime-generation";

export const DEVICE_OFFLINE_QUEUE_LEASE_MS = 60_000;
export const DEVICE_OFFLINE_QUEUE_HEARTBEAT_MS = 20_000;
export const DEVICE_OFFLINE_AUTO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const DEVICE_OFFLINE_AUTO_LIMIT_OPTIONS = [25, 50, 100, 200] as const;

export interface DeviceOfflineAutomationSettings {
    ownerId: string;
    autoDownloadLiked: boolean;
    autoDownloadLikedLimit: number;
    autoDownloadMaxBytes: number;
    updatedAt: number;
}

export const DEFAULT_DEVICE_OFFLINE_AUTOMATION_SETTINGS = {
    autoDownloadLiked: false,
    autoDownloadLikedLimit: 100,
    autoDownloadMaxBytes: DEVICE_OFFLINE_AUTO_MAX_BYTES,
    updatedAt: 0,
} as const;

export type DeviceOfflineQueueStatus =
    | "queued"
    | "processing"
    | "interrupted"
    | "error";

/** Durable browser-local work item. Completed items are removed. */
export interface DeviceOfflineQueueItem {
    key: string;
    ownerId: string;
    trackIdentity: string;
    quality: string;
    track: DeviceOfflineTrack;
    sourceUrl: string;
    management: DeviceOfflineManagement;
    collectionId: string | null;
    collectionLabel: string | null;
    status: DeviceOfflineQueueStatus;
    attempt: number;
    leaseId: string | null;
    leaseExpiresAt: number | null;
    createdAt: number;
    updatedAt: number;
    errorMessage: string | null;
}

export interface DeviceOfflineQueueRequest {
    ownerId: string;
    track: DeviceOfflineTrack;
    sourceUrl: string;
    quality?: string;
    management: DeviceOfflineManagement;
    collectionId?: string | null;
    collectionLabel?: string | null;
}

export interface DeviceOfflineQueueUpsert extends DeviceOfflineQueueRequest {
    key: string;
    trackIdentity: string;
    quality: string;
    now: number;
}

export interface DeviceOfflineQueueStore {
    listByOwner(ownerId: string): Promise<DeviceOfflineQueueItem[]>;
    getByKey(key: string): Promise<DeviceOfflineQueueItem | null>;
    upsert(
        input: DeviceOfflineQueueUpsert,
        isAuthorized?: () => boolean,
    ): Promise<DeviceOfflineQueueItem>;
    claimNext(
        ownerId: string,
        allowAuto: boolean,
        leaseId: string,
        now: number,
        leaseExpiresAt: number,
        isAuthorized?: () => boolean,
    ): Promise<DeviceOfflineQueueItem | null>;
    putIfCurrent(
        expected: DeviceOfflineQueueItem,
        next: DeviceOfflineQueueItem,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    deleteIfCurrent(
        expected: DeviceOfflineQueueItem,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    recoverExpired(
        ownerId: string,
        now: number,
        isAuthorized?: () => boolean,
    ): Promise<void>;
    renewLease(
        ownerId: string,
        key: string,
        leaseId: string,
        now: number,
        leaseExpiresAt: number,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    getSettings(
        ownerId: string,
    ): Promise<DeviceOfflineAutomationSettings | null>;
    putSettings(
        settings: DeviceOfflineAutomationSettings,
        isAuthorized?: () => boolean,
    ): Promise<void>;
}

interface DeviceOfflineQueueDownloadPort {
    reconcile(ownerId: string): Promise<DeviceOfflineDownloadRecord[]>;
    list(ownerId: string): Promise<DeviceOfflineDownloadRecord[]>;
    download(
        input: DeviceOfflineDownloadInput,
    ): Promise<DeviceOfflineDownloadRecord>;
    delete(
        ownerId: string,
        key: string,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    deleteAutoManagedIfCurrent(
        ownerId: string,
        expected: DeviceOfflineDownloadRecord,
    ): Promise<boolean>;
    promoteToManual(
        ownerId: string,
        key: string,
    ): Promise<DeviceOfflineDownloadRecord | null>;
}

interface DeviceOfflineQueueDependencies {
    store: DeviceOfflineQueueStore;
    downloads: DeviceOfflineQueueDownloadPort;
    now: () => number;
    createKey: () => string;
    createLeaseId: () => string;
    isOnline: () => boolean;
    scheduleLeaseHeartbeat?: (
        callback: () => void,
        intervalMs: number,
    ) => unknown;
    cancelLeaseHeartbeat?: (handle: unknown) => void;
    getAuthRuntimeLease: () => AuthRuntimeLease;
    isAuthRuntimeCurrent: (generation: number) => boolean;
}

export interface DeviceOfflineBatchEnqueueResult {
    total: number;
    queued: number;
    alreadyReady: number;
}

export interface DeviceOfflineCollectionStatus {
    total: number;
    ready: number;
    autoReady: number;
    queued: number;
    processing: number;
    errors: number;
}

function manualWins(
    current: DeviceOfflineManagement,
    requested: DeviceOfflineManagement,
): DeviceOfflineManagement {
    return current === "manual" || requested === "manual"
        ? "manual"
        : "auto-liked";
}

/** Shared deterministic merge used inside the browser's atomic IDB upsert. */
export function mergeDeviceOfflineQueueItem(
    existing: DeviceOfflineQueueItem | null,
    input: DeviceOfflineQueueUpsert,
): DeviceOfflineQueueItem {
    if (!existing) {
        return {
            key: input.key,
            ownerId: input.ownerId,
            trackIdentity: input.trackIdentity,
            quality: input.quality,
            track: structuredClone(input.track),
            sourceUrl: input.sourceUrl,
            management: input.management,
            collectionId: input.collectionId ?? null,
            collectionLabel: input.collectionLabel ?? null,
            status: "queued",
            attempt: 0,
            leaseId: null,
            leaseExpiresAt: null,
            createdAt: input.now,
            updatedAt: input.now,
            errorMessage: null,
        };
    }

    const management = manualWins(existing.management, input.management);
    const preserveAutomaticError =
        existing.status === "error" && management === "auto-liked";
    return {
        ...existing,
        track: structuredClone(input.track),
        sourceUrl: input.sourceUrl,
        management,
        collectionId: input.collectionId ?? existing.collectionId,
        collectionLabel: input.collectionLabel ?? existing.collectionLabel,
        status:
            existing.status === "processing" || preserveAutomaticError
                ? existing.status
                : "queued",
        ...(existing.status === "processing"
            ? {}
            : { leaseId: null, leaseExpiresAt: null }),
        updatedAt: input.now,
        errorMessage:
            existing.status === "processing" || preserveAutomaticError
                ? existing.errorMessage
                : null,
    };
}

/** Compare the fields that own a queue attempt across tabs. */
export function matchesDeviceOfflineQueueVersion(
    current: DeviceOfflineQueueItem | null,
    expected: DeviceOfflineQueueItem,
): boolean {
    return (
        current?.key === expected.key &&
        current.ownerId === expected.ownerId &&
        current.status === expected.status &&
        current.attempt === expected.attempt &&
        current.leaseId === expected.leaseId &&
        current.updatedAt === expected.updatedAt
    );
}

/**
 * Select and lease one owner-scoped item from an atomic queue snapshot.
 * A live lease blocks every competing tab; an expired lease is retryable.
 */
export function claimNextDeviceOfflineQueueItem(
    items: DeviceOfflineQueueItem[],
    ownerId: string,
    allowAuto: boolean,
    leaseId: string,
    now: number,
    leaseExpiresAt: number,
): DeviceOfflineQueueItem | null {
    const owned = items.filter((item) => item.ownerId === ownerId);
    const hasLiveProcessing = owned.some(
        (item) =>
            item.status === "processing" &&
            (item.leaseExpiresAt ?? Number.POSITIVE_INFINITY) > now,
    );
    if (hasLiveProcessing) return null;

    const candidate = owned
        .filter((item) => {
            const isExpiredProcessing =
                item.status === "processing" &&
                (item.leaseExpiresAt ?? 0) <= now;
            const isPending =
                item.status === "queued" ||
                item.status === "interrupted" ||
                isExpiredProcessing;
            return isPending && (allowAuto || item.management === "manual");
        })
        .sort((left, right) => {
            if (left.management !== right.management) {
                return left.management === "manual" ? -1 : 1;
            }
            return left.createdAt - right.createdAt;
        })[0];
    if (!candidate) return null;

    return {
        ...candidate,
        status: "processing",
        attempt: candidate.attempt + 1,
        leaseId,
        leaseExpiresAt,
        updatedAt: now,
        errorMessage: null,
    };
}

function normalizeAutoLimit(value: number | undefined): number {
    const requested = Number.isFinite(value) ? Number(value) : 100;
    return DEVICE_OFFLINE_AUTO_LIMIT_OPTIONS.reduce((closest, option) =>
        Math.abs(option - requested) < Math.abs(closest - requested)
            ? option
            : closest,
    );
}

function normalizeSettings(
    ownerId: string,
    stored: Partial<DeviceOfflineAutomationSettings> | null,
): DeviceOfflineAutomationSettings {
    return {
        ownerId,
        autoDownloadLiked: stored?.autoDownloadLiked === true,
        autoDownloadLikedLimit: normalizeAutoLimit(
            stored?.autoDownloadLikedLimit,
        ),
        autoDownloadMaxBytes:
            typeof stored?.autoDownloadMaxBytes === "number" &&
            Number.isFinite(stored.autoDownloadMaxBytes) &&
            stored.autoDownloadMaxBytes > 0
                ? Math.min(
                      DEVICE_OFFLINE_AUTO_MAX_BYTES,
                      Math.floor(stored.autoDownloadMaxBytes),
                  )
                : DEVICE_OFFLINE_AUTO_MAX_BYTES,
        updatedAt:
            typeof stored?.updatedAt === "number" &&
            Number.isFinite(stored.updatedAt)
                ? stored.updatedAt
                : 0,
    };
}

function recordManagement(
    record: DeviceOfflineDownloadRecord,
): DeviceOfflineManagement {
    return record.management === "auto-liked" ? "auto-liked" : "manual";
}

function findReadyRecord(
    records: DeviceOfflineDownloadRecord[],
    trackIdentity: string,
    quality: string,
): DeviceOfflineDownloadRecord | null {
    return (
        records.find(
            (record) =>
                record.trackIdentity === trackIdentity &&
                record.quality === quality &&
                record.status === "ready",
        ) ?? null
    );
}

/**
 * Durable, owner-scoped serial queue for manual batches and liked-song
 * automation. The queue never sends acquisition state to the server.
 */
export class DeviceOfflineQueueManager {
    private readonly listeners = new Set<() => void>();
    private readonly pumps = new Map<string, Promise<void>>();
    private readonly pausedOwners = new Set<string>();
    private readonly cancelledTrackKeys = new Set<string>();
    private readonly ownerAuthLeases = new Map<
        string,
        { lease: AuthRuntimeLease; retired: boolean }
    >();

    constructor(
        private readonly dependencies: DeviceOfflineQueueDependencies,
    ) {}

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Bind durable queue mutations to one authenticated owner lifecycle. */
    activateOwner(ownerId: string, lease: AuthRuntimeLease): void {
        this.ownerAuthLeases.set(ownerId, { lease, retired: false });
        this.pausedOwners.delete(ownerId);
    }

    /** Fence stale callbacks while preserving the old aborted lease. */
    retireOwner(ownerId: string, lease: AuthRuntimeLease): void {
        const current = this.ownerAuthLeases.get(ownerId);
        if (current?.lease.generation !== lease.generation) return;
        this.ownerAuthLeases.set(ownerId, { lease, retired: true });
        this.pause(ownerId);
    }

    private notify(): void {
        for (const listener of this.listeners) listener();
    }

    private trackKey(
        ownerId: string,
        trackIdentity: string,
        quality: string,
    ): string {
        return `${ownerId}\u0000${trackIdentity}\u0000${normalizeDeviceOfflineQuality(quality)}`;
    }

    private isTrackCancelled(item: DeviceOfflineQueueItem): boolean {
        return this.cancelledTrackKeys.has(
            this.trackKey(item.ownerId, item.trackIdentity, item.quality),
        );
    }

    list(ownerId: string): Promise<DeviceOfflineQueueItem[]> {
        return this.dependencies.store.listByOwner(ownerId);
    }

    async getSettings(
        ownerId: string,
    ): Promise<DeviceOfflineAutomationSettings> {
        return normalizeSettings(
            ownerId,
            await this.dependencies.store.getSettings(ownerId),
        );
    }

    async updateSettings(
        ownerId: string,
        patch: Partial<
            Pick<
                DeviceOfflineAutomationSettings,
                | "autoDownloadLiked"
                | "autoDownloadLikedLimit"
                | "autoDownloadMaxBytes"
            >
        >,
    ): Promise<DeviceOfflineAutomationSettings> {
        const authRuntimeLease = this.ownerLease(ownerId);
        const isAuthorized = () =>
            this.isOwnerAuthCurrent(ownerId, authRuntimeLease);
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        const current = await this.getSettings(ownerId);
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        const next = normalizeSettings(ownerId, {
            ...current,
            ...patch,
            updatedAt: this.dependencies.now(),
        });
        await this.dependencies.store.putSettings(next, isAuthorized);
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        if (!next.autoDownloadLiked) {
            await this.removePendingAutomaticItems(
                ownerId,
                new Set(),
                authRuntimeLease,
            );
        }
        this.notify();
        return next;
    }

    async enqueueBatch(
        requests: DeviceOfflineQueueRequest[],
    ): Promise<DeviceOfflineBatchEnqueueResult> {
        const unique = new Map<string, DeviceOfflineQueueRequest>();
        for (const request of requests) {
            const quality = normalizeDeviceOfflineQuality(request.quality);
            const identity = resolveDeviceOfflineTrackIdentity(request.track);
            unique.set(
                `${request.ownerId}\u0000${identity}\u0000${quality}`,
                request,
            );
        }

        let queued = 0;
        let alreadyReady = 0;
        let removedStaleQueueItem = false;
        const downloadsByOwner = new Map<
            string,
            DeviceOfflineDownloadRecord[]
        >();
        const authLeasesByOwner = new Map<string, AuthRuntimeLease>();
        for (const request of unique.values()) {
            const authRuntimeLease =
                authLeasesByOwner.get(request.ownerId) ??
                this.ownerLease(request.ownerId);
            authLeasesByOwner.set(request.ownerId, authRuntimeLease);
            this.assertOwnerAuthCurrent(request.ownerId, authRuntimeLease);
            const quality = normalizeDeviceOfflineQuality(request.quality);
            const trackIdentity = resolveDeviceOfflineTrackIdentity(
                request.track,
            );
            this.cancelledTrackKeys.delete(
                this.trackKey(request.ownerId, trackIdentity, quality),
            );
            let records = downloadsByOwner.get(request.ownerId);
            if (!records) {
                records = await this.dependencies.downloads.list(
                    request.ownerId,
                );
                this.assertOwnerAuthCurrent(request.ownerId, authRuntimeLease);
                downloadsByOwner.set(request.ownerId, records);
            }
            const ready = findReadyRecord(records, trackIdentity, quality);
            if (ready) {
                let retainedReady: DeviceOfflineDownloadRecord | null = ready;
                if (
                    request.management === "manual" &&
                    recordManagement(ready) === "auto-liked"
                ) {
                    retainedReady =
                        await this.dependencies.downloads.promoteToManual(
                            request.ownerId,
                            ready.key,
                        );
                    this.assertOwnerAuthCurrent(
                        request.ownerId,
                        authRuntimeLease,
                    );
                }
                if (retainedReady) {
                    for (const item of await this.dependencies.store.listByOwner(
                        request.ownerId,
                    )) {
                        this.assertOwnerAuthCurrent(
                            request.ownerId,
                            authRuntimeLease,
                        );
                        if (
                            item.trackIdentity === trackIdentity &&
                            item.quality === quality
                        ) {
                            removedStaleQueueItem =
                                (await this.dependencies.store.deleteIfCurrent(
                                    item,
                                    () =>
                                        this.isOwnerAuthCurrent(
                                            request.ownerId,
                                            authRuntimeLease,
                                        ),
                                )) || removedStaleQueueItem;
                        }
                    }
                    alreadyReady += 1;
                    continue;
                }
            }

            await this.dependencies.store.upsert(
                {
                    ...request,
                    key: this.dependencies.createKey(),
                    trackIdentity,
                    quality,
                    now: this.dependencies.now(),
                },
                () =>
                    this.isOwnerAuthCurrent(request.ownerId, authRuntimeLease),
            );
            this.assertOwnerAuthCurrent(request.ownerId, authRuntimeLease);
            queued += 1;
        }
        if (queued > 0 || removedStaleQueueItem) this.notify();
        return { total: unique.size, queued, alreadyReady };
    }

    /**
     * Cancel every durable attempt for one owner/track/quality and remove any
     * matching device copy. The in-memory tombstone also fences a worker that
     * already claimed the queue item but has not published its download yet.
     */
    async cancelTrack(
        ownerId: string,
        trackIdentity: string,
        quality: string,
    ): Promise<void> {
        const authRuntimeLease = this.ownerLease(ownerId);
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        const normalizedQuality = normalizeDeviceOfflineQuality(quality);
        this.cancelledTrackKeys.add(
            this.trackKey(ownerId, trackIdentity, normalizedQuality),
        );
        await this.deleteMatchingQueueItems(
            ownerId,
            trackIdentity,
            normalizedQuality,
            authRuntimeLease,
        );
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        await this.deleteMatchingDownloads(
            ownerId,
            trackIdentity,
            normalizedQuality,
            authRuntimeLease,
        );
        this.notify();
    }

    async syncAutoLiked(
        ownerId: string,
        requests: DeviceOfflineQueueRequest[],
    ): Promise<DeviceOfflineBatchEnqueueResult> {
        const authRuntimeLease = this.ownerLease(ownerId);
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        const settings = await this.getSettings(ownerId);
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        const unique = new Map<string, DeviceOfflineQueueRequest>();
        for (const request of requests) {
            if (
                request.ownerId !== ownerId ||
                request.management !== "auto-liked"
            ) {
                continue;
            }
            const identity = resolveDeviceOfflineTrackIdentity(request.track);
            if (!unique.has(identity)) unique.set(identity, request);
        }
        const selected = [...unique.values()].slice(
            0,
            settings.autoDownloadLikedLimit,
        );
        const keep = new Set(
            selected.map((request) =>
                resolveDeviceOfflineTrackIdentity(request.track),
            ),
        );
        await this.removePendingAutomaticItems(
            ownerId,
            settings.autoDownloadLiked ? keep : new Set(),
            authRuntimeLease,
        );
        if (!settings.autoDownloadLiked) {
            this.notify();
            return { total: 0, queued: 0, alreadyReady: 0 };
        }
        const result = await this.enqueueBatch(selected);
        await this.enforceAutoBudget(ownerId);
        return result;
    }

    private async removePendingAutomaticItems(
        ownerId: string,
        keep: Set<string>,
        authRuntimeLease: AuthRuntimeLease,
    ): Promise<void> {
        for (const item of await this.dependencies.store.listByOwner(ownerId)) {
            this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
            if (
                item.management === "auto-liked" &&
                item.status !== "processing" &&
                !keep.has(item.trackIdentity)
            ) {
                await this.dependencies.store.deleteIfCurrent(item, () =>
                    this.isOwnerAuthCurrent(ownerId, authRuntimeLease),
                );
            }
        }
    }

    pause(ownerId: string): void {
        this.pausedOwners.add(ownerId);
    }

    resume(ownerId: string): Promise<void> {
        this.pausedOwners.delete(ownerId);
        const authRuntimeLease = this.ownerLease(ownerId);
        if (!this.isRuntimeActive(ownerId, authRuntimeLease)) {
            return Promise.resolve();
        }
        const pumpKey = `${authRuntimeLease.generation}\u0000${ownerId}`;
        const active = this.pumps.get(pumpKey);
        if (active) return active;
        const pump = this.process(ownerId, authRuntimeLease).finally(() => {
            if (this.pumps.get(pumpKey) === pump) this.pumps.delete(pumpKey);
        });
        this.pumps.set(pumpKey, pump);
        return pump;
    }

    private async process(
        ownerId: string,
        authRuntimeLease: AuthRuntimeLease,
    ): Promise<void> {
        await this.dependencies.store.recoverExpired(
            ownerId,
            this.dependencies.now(),
            () => this.isOwnerAuthCurrent(ownerId, authRuntimeLease),
        );
        if (
            !this.isRuntimeActive(ownerId, authRuntimeLease) ||
            !this.dependencies.isOnline()
        ) {
            return;
        }
        await this.dependencies.downloads.reconcile(ownerId);
        if (!this.isRuntimeActive(ownerId, authRuntimeLease)) return;

        while (
            this.isRuntimeActive(ownerId, authRuntimeLease) &&
            this.dependencies.isOnline()
        ) {
            const settings = await this.getSettings(ownerId);
            if (!this.isRuntimeActive(ownerId, authRuntimeLease)) return;
            const item = await this.dependencies.store.claimNext(
                ownerId,
                settings.autoDownloadLiked,
                this.dependencies.createLeaseId(),
                this.dependencies.now(),
                this.dependencies.now() + DEVICE_OFFLINE_QUEUE_LEASE_MS,
                () => this.isOwnerAuthCurrent(ownerId, authRuntimeLease),
            );
            if (!item) return;
            if (!this.isRuntimeActive(ownerId, authRuntimeLease)) return;
            this.notify();
            const shouldContinue = await this.processItem(
                item,
                settings,
                authRuntimeLease,
            );
            this.notify();
            if (!shouldContinue) return;
        }
    }

    private async processItem(
        claimed: DeviceOfflineQueueItem,
        settings: DeviceOfflineAutomationSettings,
        authRuntimeLease: AuthRuntimeLease,
    ): Promise<boolean> {
        const heartbeat = this.dependencies.scheduleLeaseHeartbeat?.(() => {
            if (!this.isRuntimeActive(claimed.ownerId, authRuntimeLease)) {
                return;
            }
            void this.dependencies.store
                .renewLease(
                    claimed.ownerId,
                    claimed.key,
                    claimed.leaseId ?? "",
                    this.dependencies.now(),
                    this.dependencies.now() + DEVICE_OFFLINE_QUEUE_LEASE_MS,
                    () =>
                        this.isOwnerAuthCurrent(
                            claimed.ownerId,
                            authRuntimeLease,
                        ),
                )
                .catch(() => undefined);
        }, DEVICE_OFFLINE_QUEUE_HEARTBEAT_MS);
        try {
            if (!this.isRuntimeActive(claimed.ownerId, authRuntimeLease)) {
                return false;
            }
            if (this.isTrackCancelled(claimed)) {
                await this.cleanupCancelledTrack(claimed, authRuntimeLease);
                return true;
            }
            const records = await this.dependencies.downloads.list(
                claimed.ownerId,
            );
            if (!this.isRuntimeActive(claimed.ownerId, authRuntimeLease)) {
                return false;
            }
            const ready = findReadyRecord(
                records,
                claimed.trackIdentity,
                claimed.quality,
            );
            if (this.isTrackCancelled(claimed)) {
                await this.cleanupCancelledTrack(claimed, authRuntimeLease);
                return true;
            }
            if (ready) {
                if (claimed.management === "manual") {
                    await this.dependencies.downloads.promoteToManual(
                        claimed.ownerId,
                        ready.key,
                    );
                }
                await this.deleteLatestQueueItem(
                    claimed.ownerId,
                    claimed.key,
                    authRuntimeLease,
                );
                return true;
            }

            if (this.isTrackCancelled(claimed)) {
                await this.cleanupCancelledTrack(claimed, authRuntimeLease);
                return true;
            }
            const latestBeforeDownload = await this.dependencies.store.getByKey(
                claimed.key,
            );
            if (!this.isRuntimeActive(claimed.ownerId, authRuntimeLease)) {
                return false;
            }
            if (!this.ownsQueueLease(latestBeforeDownload, claimed)) {
                return true;
            }
            const downloaded = await this.dependencies.downloads.download({
                ownerId: claimed.ownerId,
                track: claimed.track,
                quality: claimed.quality,
                sourceUrl: claimed.sourceUrl,
                management: claimed.management,
            });
            if (!this.isRuntimeActive(claimed.ownerId, authRuntimeLease)) {
                return false;
            }
            if (this.isTrackCancelled(claimed)) {
                await this.cleanupCancelledTrack(claimed, authRuntimeLease);
                return true;
            }
            const latest = await this.dependencies.store.getByKey(claimed.key);
            if (!latest) {
                // Another tab removed the durable queue item while this tab was
                // downloading. Do not resurrect a copy after that cancellation.
                await this.dependencies.downloads.delete(
                    downloaded.ownerId,
                    downloaded.key,
                );
                return true;
            }
            if (!this.ownsQueueLease(latest, claimed)) return true;
            if (downloaded.status !== "ready") {
                await this.markQueueFailure(
                    latest,
                    "interrupted",
                    "Download interrupted; it will continue when this device is online.",
                    authRuntimeLease,
                );
                return false;
            }
            if (latest.management === "manual") {
                await this.dependencies.downloads.promoteToManual(
                    latest.ownerId,
                    downloaded.key,
                );
            } else {
                await this.enforceAutoBudget(latest.ownerId, settings);
                const retained = (
                    await this.dependencies.downloads.list(latest.ownerId)
                ).some((record) => record.key === downloaded.key);
                if (!retained) {
                    await this.markQueueFailure(
                        latest,
                        "error",
                        "This track exceeds the automatic-download budget.",
                        authRuntimeLease,
                    );
                    return true;
                }
            }
            await this.deleteLatestQueueItem(
                latest.ownerId,
                latest.key,
                authRuntimeLease,
            );
            return true;
        } catch (error) {
            if (!this.isRuntimeActive(claimed.ownerId, authRuntimeLease)) {
                return false;
            }
            if (this.isTrackCancelled(claimed)) {
                await this.cleanupCancelledTrack(claimed, authRuntimeLease);
                return true;
            }
            const latest = await this.dependencies.store.getByKey(claimed.key);
            if (!latest) return true;
            const records = await this.dependencies.downloads
                .list(claimed.ownerId)
                .catch(() => []);
            const download = records.find(
                (record) =>
                    record.trackIdentity === claimed.trackIdentity &&
                    record.quality === claimed.quality,
            );
            const interrupted =
                !this.dependencies.isOnline() ||
                download?.status === "interrupted";
            await this.markQueueFailure(
                latest,
                interrupted ? "interrupted" : "error",
                error instanceof Error ? error.message : "Download failed",
                authRuntimeLease,
            );
            return !interrupted;
        } finally {
            if (heartbeat !== undefined) {
                this.dependencies.cancelLeaseHeartbeat?.(heartbeat);
            }
        }
    }

    private async markQueueFailure(
        expected: DeviceOfflineQueueItem,
        status: "interrupted" | "error",
        errorMessage: string,
        authRuntimeLease: AuthRuntimeLease,
    ): Promise<void> {
        await this.dependencies.store.putIfCurrent(
            expected,
            {
                ...expected,
                status,
                leaseId: null,
                leaseExpiresAt: null,
                updatedAt: this.dependencies.now(),
                errorMessage,
            },
            () => this.isOwnerAuthCurrent(expected.ownerId, authRuntimeLease),
        );
    }

    private ownsQueueLease(
        current: DeviceOfflineQueueItem | null,
        claimed: DeviceOfflineQueueItem,
    ): current is DeviceOfflineQueueItem {
        return (
            current?.ownerId === claimed.ownerId &&
            current.status === "processing" &&
            current.attempt === claimed.attempt &&
            current.leaseId === claimed.leaseId
        );
    }

    private ownerLease(ownerId: string): AuthRuntimeLease {
        return (
            this.ownerAuthLeases.get(ownerId)?.lease ??
            this.dependencies.getAuthRuntimeLease()
        );
    }

    private assertOwnerAuthCurrent(
        ownerId: string,
        authRuntimeLease: AuthRuntimeLease,
    ): void {
        if (!this.isOwnerAuthCurrent(ownerId, authRuntimeLease)) {
            throw new Error(
                "Authentication session changed while the device queue was pending",
            );
        }
    }

    private isOwnerAuthCurrent(
        ownerId: string,
        authRuntimeLease: AuthRuntimeLease,
    ): boolean {
        const ownerLease = this.ownerAuthLeases.get(ownerId);
        return (
            !authRuntimeLease.signal.aborted &&
            ownerLease?.retired !== true &&
            (ownerLease?.lease.generation ?? authRuntimeLease.generation) ===
                authRuntimeLease.generation &&
            this.dependencies.isAuthRuntimeCurrent(authRuntimeLease.generation)
        );
    }

    private isRuntimeActive(
        ownerId: string,
        authRuntimeLease: AuthRuntimeLease,
    ): boolean {
        return (
            !this.pausedOwners.has(ownerId) &&
            this.isOwnerAuthCurrent(ownerId, authRuntimeLease)
        );
    }

    private async deleteLatestQueueItem(
        ownerId: string,
        key: string,
        authRuntimeLease: AuthRuntimeLease,
    ): Promise<void> {
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        const latest = await this.dependencies.store.getByKey(key);
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        if (latest?.ownerId === ownerId) {
            await this.dependencies.store.deleteIfCurrent(latest, () =>
                this.isOwnerAuthCurrent(ownerId, authRuntimeLease),
            );
        }
    }

    private async deleteMatchingQueueItems(
        ownerId: string,
        trackIdentity: string,
        quality: string,
        authRuntimeLease: AuthRuntimeLease,
    ): Promise<void> {
        const matches = (item: DeviceOfflineQueueItem) =>
            item.ownerId === ownerId &&
            item.trackIdentity === trackIdentity &&
            item.quality === quality;
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        const items = await this.dependencies.store.listByOwner(ownerId);
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        for (const item of items) {
            if (!matches(item)) continue;
            for (let attempt = 0; attempt < 4; attempt += 1) {
                this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
                const latest = await this.dependencies.store.getByKey(item.key);
                this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
                if (!latest || !matches(latest)) break;
                if (
                    await this.dependencies.store.deleteIfCurrent(latest, () =>
                        this.isOwnerAuthCurrent(ownerId, authRuntimeLease),
                    )
                ) {
                    break;
                }
            }
        }
    }

    private async deleteMatchingDownloads(
        ownerId: string,
        trackIdentity: string,
        quality: string,
        authRuntimeLease: AuthRuntimeLease,
    ): Promise<void> {
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        const records = await this.dependencies.downloads.list(ownerId);
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        for (const record of records) {
            if (
                record.trackIdentity === trackIdentity &&
                record.quality === quality
            ) {
                this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
                await this.dependencies.downloads.delete(
                    ownerId,
                    record.key,
                    () => this.isOwnerAuthCurrent(ownerId, authRuntimeLease),
                );
                this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
            }
        }
    }

    private async cleanupCancelledTrack(
        item: DeviceOfflineQueueItem,
        authRuntimeLease: AuthRuntimeLease,
    ): Promise<void> {
        await this.deleteMatchingQueueItems(
            item.ownerId,
            item.trackIdentity,
            item.quality,
            authRuntimeLease,
        );
        await this.deleteMatchingDownloads(
            item.ownerId,
            item.trackIdentity,
            item.quality,
            authRuntimeLease,
        );
    }

    async enforceAutoBudget(
        ownerId: string,
        providedSettings?: DeviceOfflineAutomationSettings,
    ): Promise<string[]> {
        const authRuntimeLease = this.ownerLease(ownerId);
        this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
        const settings = providedSettings ?? (await this.getSettings(ownerId));
        const deleted: string[] = [];
        while (true) {
            this.assertOwnerAuthCurrent(ownerId, authRuntimeLease);
            const automatic = (await this.dependencies.downloads.list(ownerId))
                .filter(
                    (record) =>
                        record.status === "ready" &&
                        recordManagement(record) === "auto-liked",
                )
                .sort(
                    (left, right) =>
                        left.createdAt - right.createdAt ||
                        left.updatedAt - right.updatedAt,
                );
            const bytes = automatic.reduce(
                (total, record) => total + Math.max(0, record.totalBytes ?? 0),
                0,
            );
            if (
                automatic.length <= settings.autoDownloadLikedLimit &&
                bytes <= settings.autoDownloadMaxBytes
            ) {
                break;
            }
            const oldest = automatic[0];
            if (!oldest) break;
            if (
                await this.dependencies.downloads.deleteAutoManagedIfCurrent(
                    ownerId,
                    oldest,
                )
            ) {
                deleted.push(oldest.key);
            }
        }
        return deleted;
    }
}

/** Summarize actual ready records plus pending queue work for one collection. */
export function summarizeDeviceOfflineCollection(
    records: DeviceOfflineDownloadRecord[],
    queue: DeviceOfflineQueueItem[],
    tracks: DeviceOfflineTrack[],
    quality = "auto",
): DeviceOfflineCollectionStatus {
    const normalizedQuality = normalizeDeviceOfflineQuality(quality);
    const identities = Array.from(
        new Set(
            tracks.map((track) => resolveDeviceOfflineTrackIdentity(track)),
        ),
    );
    let ready = 0;
    let autoReady = 0;
    let queued = 0;
    let processing = 0;
    let errors = 0;
    for (const identity of identities) {
        const record = records.find(
            (candidate) =>
                candidate.trackIdentity === identity &&
                candidate.quality === normalizedQuality,
        );
        if (record?.status === "ready") {
            ready += 1;
            if (recordManagement(record) === "auto-liked") autoReady += 1;
            continue;
        }
        const item = queue.find(
            (candidate) =>
                candidate.trackIdentity === identity &&
                candidate.quality === normalizedQuality,
        );
        if (item?.status === "processing") processing += 1;
        else if (item?.status === "queued" || item?.status === "interrupted") {
            queued += 1;
        } else if (item?.status === "error" || record) errors += 1;
    }
    return {
        total: identities.length,
        ready,
        autoReady,
        queued,
        processing,
        errors,
    };
}
