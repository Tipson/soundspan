import {
    backgroundFetchIdForKey,
    type DeviceOfflineBackgroundFetchAbortResult,
    type DeviceOfflineBackgroundFetchStartResult,
} from "./platform";
import {
    buildDeviceOfflineVirtualUrl,
    normalizeDeviceOfflineQuality,
    resolveDeviceOfflineTrackIdentity,
} from "./trackIdentity";
import type {
    DeviceOfflineDownloadInput,
    DeviceOfflineDownloadRecord,
} from "./types";
import type { AuthRuntimeLease } from "@/lib/auth-runtime-generation";
import {
    assertLegacyCacheQuotaAvailable,
    createLegacyCachedAudioResponse,
    parseDeviceAudioContentLength,
    verifyLegacyCachedAudioBytes,
} from "./audioResponse";
import {
    classifyDeviceOfflineFailure,
    DeviceOfflineDownloadError,
    StaleDeviceOfflineAttemptError,
    SupersededDeviceOfflineAuthRuntimeError,
} from "./downloadError";
import {
    backgroundLeaseRetry,
    isCurrentForegroundAttempt,
    publishDeviceOfflineProgress,
} from "./downloadAttemptState";
import { normalizeDeviceAudioSourceUrl } from "./sourceValidation";
import { type DeviceAudioVault } from "./vault";
import { completeDeviceAudioDownload } from "./vaultRetention";
import {
    inspectDeviceAudioRecord,
    reconcileDeviceAudioRecord,
    removeDeviceAudioRecord,
} from "./vaultRecordAccess";
import { migrateLegacyDeviceAudioCache } from "./legacyCacheMigration";
import {
    deleteManagedDeviceOfflineRecord,
    promoteReadyDeviceOfflineRecord,
    reuseReadyDeviceOfflineRecord,
} from "./downloadRecordManagement";
import {
    clampForegroundLeaseClockSkew,
    DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
    DEVICE_OFFLINE_LEASE_MAX_FUTURE_MS,
    foregroundLeaseDisposition,
    interruptExpiredForegroundRecord,
    type ForegroundLeaseDisposition,
} from "./foregroundLease";
export {
    clampForegroundLeaseClockSkew,
    DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
    foregroundLeaseDisposition,
    interruptExpiredForegroundRecord,
    type ForegroundLeaseDisposition,
};
export const DEVICE_OFFLINE_FOREGROUND_HEARTBEAT_MS = 10_000;
export const DEVICE_OFFLINE_PROGRESS_UPDATE_INTERVAL_MS = 500;
export const DEVICE_OFFLINE_PROGRESS_UPDATE_MIN_BYTES = 256 * 1024;
export const DEVICE_OFFLINE_BACKGROUND_MISSING_GRACE_MS = 10_000;
export const DEVICE_OFFLINE_BACKGROUND_LOOKUP_TIMEOUT_MS = 1_500;
export const DEVICE_OFFLINE_BACKGROUND_UNKNOWN_RETRY_LIMIT = 3;
export const DEVICE_OFFLINE_BACKGROUND_STALL_MS = 5 * 60_000;
const DEVICE_OFFLINE_BACKGROUND_UNKNOWN_LEASE_PREFIX = "background-unknown:";
const DEVICE_OFFLINE_BACKGROUND_STALL_LEASE_PREFIX = "background-stall:";
const DEVICE_OFFLINE_BACKGROUND_COMPLETION_LEASE_PREFIX =
    "background-completing:";

export interface DeviceOfflineMetadataStore {
    listByOwner(ownerId: string): Promise<DeviceOfflineDownloadRecord[]>;
    getByKey(key: string): Promise<DeviceOfflineDownloadRecord | null>;
    getByTrackQuality(
        ownerId: string,
        trackIdentity: string,
        quality: string,
    ): Promise<DeviceOfflineDownloadRecord | null>;
    claimReplacement(
        expected: DeviceOfflineDownloadRecord | null,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    put(record: DeviceOfflineDownloadRecord): Promise<void>;
    putIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    putAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    interruptForegroundIfLeaseExpired(
        expected: DeviceOfflineDownloadRecord,
        now: number,
    ): Promise<boolean>;
    deleteIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    deleteAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
}

export interface DeviceOfflineAudioCache {
    put(url: string, response: Response): Promise<void>;
    match(url: string): Promise<Response | null>;
    delete(url: string): Promise<void>;
}

export interface DeviceOfflineManagerDependencies {
    metadataStore: DeviceOfflineMetadataStore;
    audioCache: DeviceOfflineAudioCache;
    /** Real device-file destination for all new production downloads. */
    audioVault?: DeviceAudioVault;
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    now: () => number;
    createKey: () => string;
    origin: string;
    requestPersistentStorage: () => Promise<boolean | null>;
    estimateStorage: () => Promise<{
        usage?: number;
        quota?: number;
    } | null>;
    startBackgroundFetch: (
        record: DeviceOfflineDownloadRecord,
        sourceUrl: string,
    ) => Promise<DeviceOfflineBackgroundFetchStartResult>;
    abortBackgroundFetch: (
        record: DeviceOfflineDownloadRecord,
    ) => Promise<DeviceOfflineBackgroundFetchAbortResult>;
    listActiveBackgroundFetches: () => Promise<string[]>;
    backgroundFetchLookupTimeoutMs?: number;
    scheduleLeaseHeartbeat: (
        callback: () => void,
        intervalMs: number,
    ) => unknown;
    cancelLeaseHeartbeat: (handle: unknown) => void;
    scheduleLeaseExpiryCheck: (
        callback: () => void,
        delayMs: number,
    ) => unknown;
    cancelLeaseExpiryCheck: (handle: unknown) => void;
    getAuthRuntimeLease: () => AuthRuntimeLease;
    isAuthRuntimeCurrent: (generation: number) => boolean;
}

type DeviceOfflineListener = () => void;

export function matchesDeviceOfflineRecordVersion(
    current: DeviceOfflineDownloadRecord | null,
    expected: DeviceOfflineDownloadRecord,
): boolean {
    return (
        current?.key === expected.key &&
        current.ownerId === expected.ownerId &&
        current.attempt === expected.attempt &&
        current.status === expected.status &&
        current.transferMode === expected.transferMode &&
        current.backgroundFetchId === expected.backgroundFetchId &&
        (current.mediaRef ?? null) === (expected.mediaRef ?? null) &&
        (current.foregroundLeaseId ?? null) ===
            (expected.foregroundLeaseId ?? null)
    );
}

/** Preserve monotonic progress when a lease heartbeat and reader write race. */
export function mergeConcurrentDeviceOfflineUpdate(
    current: DeviceOfflineDownloadRecord,
    next: DeviceOfflineDownloadRecord,
): DeviceOfflineDownloadRecord {
    const monotonicNext: DeviceOfflineDownloadRecord = {
        ...next,
        management:
            current.management === "auto-liked" &&
            next.management === "auto-liked"
                ? "auto-liked"
                : "manual",
        updatedAt: Math.max(current.updatedAt, next.updatedAt),
    };
    const sameForegroundAttempt =
        current.key === next.key &&
        current.ownerId === next.ownerId &&
        current.attempt === next.attempt &&
        current.status === "downloading" &&
        next.status === "downloading" &&
        current.transferMode === "foreground" &&
        next.transferMode === "foreground" &&
        (current.foregroundLeaseId ?? null) ===
            (next.foregroundLeaseId ?? null);
    if (!sameForegroundAttempt) return monotonicNext;

    return {
        ...monotonicNext,
        bytesReceived: Math.max(current.bytesReceived, next.bytesReceived),
        totalBytes: current.totalBytes ?? next.totalBytes,
        contentType: current.contentType ?? next.contentType,
        foregroundLeaseExpiresAt: Math.max(
            current.foregroundLeaseExpiresAt ?? 0,
            next.foregroundLeaseExpiresAt ?? 0,
        ),
    };
}

/** Coordinates one-track foreground/background downloads without server jobs. */
export class DeviceOfflineDownloadManager {
    private readonly listeners = new Set<DeviceOfflineListener>();
    private readonly inFlightByIdentity = new Map<
        string,
        Promise<DeviceOfflineDownloadRecord>
    >();
    private readonly abortByKey = new Map<
        string,
        { ownerId: string; controller: AbortController }
    >();
    private readonly deletedKeys = new Set<string>();
    private readonly leaseExpiryCheckByKey = new Map<string, unknown>();
    private readonly ownerAuthLeases = new Map<
        string,
        { lease: AuthRuntimeLease; retired: boolean }
    >();

    constructor(
        private readonly dependencies: DeviceOfflineManagerDependencies,
    ) {}

    subscribe(listener: DeviceOfflineListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Bind device mutations to one authenticated owner lifecycle. */
    activateOwner(ownerId: string, lease: AuthRuntimeLease): void {
        this.ownerAuthLeases.set(ownerId, { lease, retired: false });
    }

    /** Keep an aborted lease as a fence for stale callbacks after cleanup. */
    retireOwner(ownerId: string, lease: AuthRuntimeLease): void {
        const current = this.ownerAuthLeases.get(ownerId);
        if (current?.lease.generation !== lease.generation) return;
        this.ownerAuthLeases.set(ownerId, { lease, retired: true });
        this.abortOwner(ownerId);
    }

    private notify(): void {
        for (const listener of this.listeners) listener();
    }

    async list(ownerId: string): Promise<DeviceOfflineDownloadRecord[]> {
        const records =
            await this.dependencies.metadataStore.listByOwner(ownerId);
        return records.sort((left, right) => right.updatedAt - left.updatedAt);
    }

    /** Move prior CacheStorage copies after the user explicitly selects a folder. */
    async migrateLegacyCache(ownerId: string): Promise<number> {
        const vault = this.dependencies.audioVault;
        if (!vault) return 0;
        const lease = this.ownerLease(ownerId);
        const isAuthorized = () => this.isAuthLeaseCurrent(ownerId, lease);
        this.assertCurrentAuthRuntime(ownerId, lease);
        const records = await this.list(ownerId);
        this.assertCurrentAuthRuntime(ownerId, lease);
        const migrated = await migrateLegacyDeviceAudioCache({
            ownerId,
            authGeneration: lease.generation,
            records,
            vault,
            audioCache: this.dependencies.audioCache,
            origin: this.dependencies.origin,
            signal: lease.signal,
            now: this.dependencies.now,
            publish: (expected, next) =>
                this.dependencies.metadataStore.putIfCurrent(
                    expected,
                    next,
                    isAuthorized,
                ),
        });
        if (migrated > 0) this.notify();
        return migrated;
    }

    async reconcile(ownerId: string): Promise<DeviceOfflineDownloadRecord[]> {
        const records = await this.list(ownerId);
        let activeBackgroundIds: Set<string> | null = null;
        const needsBackgroundEnumeration = records.some(
            (record) =>
                record.status === "downloading" &&
                record.transferMode === "background" &&
                record.backgroundFetchId !== null,
        );
        if (needsBackgroundEnumeration) {
            try {
                const backgroundFetchLookup =
                    this.dependencies.listActiveBackgroundFetches();
                activeBackgroundIds = new Set(
                    await new Promise<string[]>((resolve, reject) => {
                        const timer = setTimeout(
                            () =>
                                reject(
                                    new Error(
                                        "Истекло время ожидания списка Background Fetch",
                                    ),
                                ),
                            this.dependencies.backgroundFetchLookupTimeoutMs ??
                                DEVICE_OFFLINE_BACKGROUND_LOOKUP_TIMEOUT_MS,
                        );
                        void backgroundFetchLookup.then(
                            (ids) => {
                                clearTimeout(timer);
                                resolve(ids);
                            },
                            (error: unknown) => {
                                clearTimeout(timer);
                                reject(error);
                            },
                        );
                    }),
                );
            } catch {
                // Enumeration failure means unknown, not that active transfers ended.
            }
        }

        for (const record of records) {
            let next: DeviceOfflineDownloadRecord | null = null;
            let cacheUrlToDelete: string | null = null;
            let abortBackgroundRegistration = false;
            if (
                record.status === "ready" &&
                record.mediaRef &&
                this.dependencies.audioVault
            ) {
                const inspection = await inspectDeviceAudioRecord(
                    this.dependencies.audioVault,
                    record,
                    this.ownerLease(ownerId).generation,
                );
                next = reconcileDeviceAudioRecord(
                    record,
                    inspection,
                    this.dependencies.now(),
                );
                if (record.backgroundFetchId !== null) {
                    next = {
                        ...(next ?? record),
                        backgroundFetchId: null,
                        foregroundLeaseId: null,
                        foregroundLeaseExpiresAt: null,
                    };
                    abortBackgroundRegistration = true;
                }
            } else if (record.status === "ready") {
                const absoluteVirtualUrl = new URL(
                    record.virtualUrl,
                    this.dependencies.origin,
                ).toString();
                let cached: Response | null = null;
                try {
                    cached =
                        await this.dependencies.audioCache.match(
                            absoluteVirtualUrl,
                        );
                } catch {
                    next = {
                        ...record,
                        status: "interrupted",
                        errorCode: "cache_unavailable",
                        errorMessage:
                            "Не удалось проверить хранилище браузера. Повторите загрузку этой копии на устройство.",
                        updatedAt: this.dependencies.now(),
                    };
                }
                if (!next && !cached) {
                    next = {
                        ...record,
                        status: "interrupted",
                        errorCode: "cache_missing",
                        errorMessage:
                            "Браузер удалил эту копию с устройства. Возобновите загрузку, чтобы скачать её снова.",
                        updatedAt: this.dependencies.now(),
                    };
                } else if (cached) {
                    try {
                        const alreadyVerified =
                            record.integrityVersion === 1 &&
                            typeof record.totalBytes === "number" &&
                            record.totalBytes > 0 &&
                            record.bytesReceived === record.totalBytes;
                        if (!alreadyVerified) {
                            const verifiedBytes =
                                await verifyLegacyCachedAudioBytes(
                                    cached,
                                    record.totalBytes,
                                );
                            next = {
                                ...record,
                                bytesReceived: verifiedBytes,
                                totalBytes: verifiedBytes,
                                integrityVersion: 1,
                            };
                        }
                    } catch {
                        next = {
                            ...record,
                            status: "interrupted",
                            errorCode: "cache_integrity",
                            errorMessage:
                                "Эта копия на устройстве неполная. Повторите загрузку.",
                            updatedAt: this.dependencies.now(),
                        };
                        cacheUrlToDelete = absoluteVirtualUrl;
                    }
                }
                if (record.backgroundFetchId !== null) {
                    next = {
                        ...(next ?? record),
                        backgroundFetchId: null,
                        foregroundLeaseId: null,
                        foregroundLeaseExpiresAt: null,
                    };
                    abortBackgroundRegistration = true;
                }
            } else if (
                record.status === "downloading" &&
                record.transferMode === "background" &&
                this.dependencies.now() - record.updatedAt >=
                    DEVICE_OFFLINE_BACKGROUND_STALL_MS
            ) {
                next = {
                    ...record,
                    status: "interrupted",
                    backgroundFetchId: null,
                    foregroundLeaseId: null,
                    foregroundLeaseExpiresAt: null,
                    errorCode: "background_stalled",
                    errorMessage:
                        "Фоновая загрузка браузера зависла. При повторе начнётся проверенная загрузка в активном окне.",
                    updatedAt: this.dependencies.now(),
                };
                abortBackgroundRegistration = true;
            } else if (
                record.status === "downloading" &&
                record.transferMode === "foreground"
            ) {
                const interrupted =
                    await this.dependencies.metadataStore.interruptForegroundIfLeaseExpired(
                        record,
                        this.dependencies.now(),
                    );
                if (!interrupted) {
                    await this.scheduleCurrentLeaseExpiryCheck(record.key);
                }
                continue;
            } else if (
                record.status === "downloading" &&
                record.transferMode === "background" &&
                record.backgroundFetchId !== null &&
                activeBackgroundIds?.has(record.backgroundFetchId)
            ) {
                if (
                    record.foregroundLeaseId?.startsWith(
                        DEVICE_OFFLINE_BACKGROUND_STALL_LEASE_PREFIX,
                    ) ||
                    record.foregroundLeaseId?.startsWith(
                        DEVICE_OFFLINE_BACKGROUND_COMPLETION_LEASE_PREFIX,
                    )
                ) {
                    this.scheduleLeaseExpiryCheck(record);
                    continue;
                }
                next = {
                    ...record,
                    foregroundLeaseId: `${DEVICE_OFFLINE_BACKGROUND_STALL_LEASE_PREFIX}${record.backgroundFetchId}`,
                    foregroundLeaseExpiresAt:
                        record.updatedAt + DEVICE_OFFLINE_BACKGROUND_STALL_MS,
                };
            } else if (
                record.status === "downloading" &&
                record.transferMode === "background" &&
                !record.backgroundFetchId
            ) {
                next = {
                    ...record,
                    status: "interrupted",
                    foregroundLeaseId: null,
                    foregroundLeaseExpiresAt: null,
                    errorCode: "interrupted",
                    errorMessage:
                        "Загрузка была прервана. При продолжении загрузка этого трека начнётся заново.",
                    updatedAt: this.dependencies.now(),
                };
            } else if (
                record.status === "downloading" &&
                record.transferMode === "background" &&
                record.backgroundFetchId !== null &&
                activeBackgroundIds !== null &&
                !activeBackgroundIds.has(record.backgroundFetchId)
            ) {
                if (!record.foregroundLeaseId) {
                    const graceStartedAt = this.dependencies.now();
                    const graceRecord: DeviceOfflineDownloadRecord = {
                        ...record,
                        foregroundLeaseId: `background-missing:${record.backgroundFetchId}`,
                        foregroundLeaseExpiresAt:
                            graceStartedAt +
                            DEVICE_OFFLINE_BACKGROUND_MISSING_GRACE_MS,
                        updatedAt: graceStartedAt,
                    };
                    if (
                        await this.dependencies.metadataStore.putIfCurrent(
                            record,
                            graceRecord,
                        )
                    ) {
                        this.scheduleLeaseExpiryCheck(graceRecord);
                    }
                    continue;
                }
                const interrupted =
                    await this.dependencies.metadataStore.interruptForegroundIfLeaseExpired(
                        record,
                        this.dependencies.now(),
                    );
                if (!interrupted) {
                    await this.scheduleCurrentLeaseExpiryCheck(record.key);
                }
                continue;
            }

            if (next) {
                const updated =
                    await this.dependencies.metadataStore.putIfCurrent(
                        record,
                        next,
                    );
                if (updated && !next.foregroundLeaseId) {
                    this.cancelScheduledLeaseExpiryCheck(record.key);
                } else if (updated) {
                    this.scheduleLeaseExpiryCheck(next);
                }
                if (updated && cacheUrlToDelete) {
                    await this.dependencies.audioCache
                        .delete(cacheUrlToDelete)
                        .catch(() => undefined);
                }
                if (updated && abortBackgroundRegistration) {
                    await this.dependencies
                        .abortBackgroundFetch(record)
                        .catch(() => undefined);
                }
            }
        }
        return this.list(ownerId);
    }

    download(
        input: DeviceOfflineDownloadInput,
    ): Promise<DeviceOfflineDownloadRecord> {
        const authRuntimeLease = this.ownerLease(input.ownerId);
        this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
        const quality = normalizeDeviceOfflineQuality(input.quality);
        const trackIdentity = resolveDeviceOfflineTrackIdentity(input.track);
        const inFlightKey = `${authRuntimeLease.generation}\u0000${input.ownerId}\u0000${trackIdentity}\u0000${quality}`;
        const existing = this.inFlightByIdentity.get(inFlightKey);
        if (existing) {
            return (input.management ?? "manual") === "manual"
                ? existing.then(async (record) => {
                      const promoted = await this.promoteToManual(
                          input.ownerId,
                          record.key,
                      );
                      return promoted ?? this.download(input);
                  })
                : existing;
        }

        const promise = this.runDownload(
            {
                ...input,
                quality,
            },
            authRuntimeLease,
        ).finally(() => {
            this.inFlightByIdentity.delete(inFlightKey);
        });
        this.inFlightByIdentity.set(inFlightKey, promise);
        return promise;
    }

    private async runDownload(
        input: DeviceOfflineDownloadInput & { quality: string },
        authRuntimeLease: AuthRuntimeLease,
    ): Promise<DeviceOfflineDownloadRecord> {
        const isAuthorized = () =>
            this.isAuthLeaseCurrent(input.ownerId, authRuntimeLease);
        this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
        const source = normalizeDeviceAudioSourceUrl(
            input.sourceUrl,
            this.dependencies.origin,
        );
        const trackIdentity = resolveDeviceOfflineTrackIdentity(input.track);
        const previous =
            await this.dependencies.metadataStore.getByTrackQuality(
                input.ownerId,
                trackIdentity,
                input.quality,
            );
        this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
        const requestedManagement = input.management ?? "manual";
        const reusable = await reuseReadyDeviceOfflineRecord(
            this.dependencies,
            {
                previous,
                ownerId: input.ownerId,
                trackIdentity,
                quality: input.quality,
                requestedManagement,
                isAuthorized,
                notifyChanged: () => this.notify(),
                assertAuthorized: () =>
                    this.assertCurrentAuthRuntime(
                        input.ownerId,
                        authRuntimeLease,
                    ),
            },
        );
        if (reusable.record) return reusable.record;
        const { management } = reusable;
        const key = this.dependencies.createKey();
        const virtualUrl = buildDeviceOfflineVirtualUrl(key);
        const attempt = (previous?.attempt ?? 0) + 1;
        const foregroundLeaseId = `${key}:${attempt}`;
        const persistenceGranted = this.dependencies.audioVault
            ? null
            : await this.dependencies
                  .requestPersistentStorage()
                  .catch(() => null);
        this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
        const now = this.dependencies.now();
        let record: DeviceOfflineDownloadRecord = {
            key,
            ownerId: input.ownerId,
            trackIdentity,
            quality: input.quality,
            virtualUrl,
            sourceUrl: source.stored,
            track: structuredClone(input.track),
            status: "downloading",
            transferMode: "foreground",
            backgroundFetchId: null,
            foregroundLeaseId,
            foregroundLeaseExpiresAt:
                now + DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
            bytesReceived: 0,
            totalBytes: null,
            contentType: null,
            persistenceGranted,
            management,
            attempt,
            createdAt: previous?.createdAt ?? now,
            updatedAt: now,
            errorCode: null,
            errorMessage: null,
        };
        this.deletedKeys.delete(key);
        const claimed = await this.dependencies.metadataStore.claimReplacement(
            previous,
            record,
            isAuthorized,
        );
        if (!claimed) throw new StaleDeviceOfflineAttemptError();
        if (previous) {
            const previousAudioCleanup =
                previous.mediaRef && this.dependencies.audioVault
                    ? removeDeviceAudioRecord(
                          this.dependencies.audioVault,
                          previous,
                          authRuntimeLease.generation,
                      )
                    : this.dependencies.audioCache.delete(
                          new URL(
                              previous.virtualUrl,
                              this.dependencies.origin,
                          ).toString(),
                      );
            await Promise.allSettled([
                this.dependencies.abortBackgroundFetch(previous),
                previousAudioCleanup,
            ]);
        }
        this.notify();

        let stopLeaseHeartbeat: (() => void) | null = null;
        let cacheWriteSettlement: Promise<
            { status: "fulfilled" } | { status: "rejected"; reason: unknown }
        > | null = null;
        let unlinkAuthAbort: (() => void) | null = null;
        try {
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            if (this.dependencies.audioVault) {
                stopLeaseHeartbeat = this.startForegroundLeaseHeartbeat(
                    record,
                    authRuntimeLease,
                );
                const controller = new AbortController();
                this.abortByKey.set(key, {
                    ownerId: input.ownerId,
                    controller,
                });
                const abortForAuthRotation = () => controller.abort();
                authRuntimeLease.signal.addEventListener(
                    "abort",
                    abortForAuthRotation,
                    { once: true },
                );
                unlinkAuthAbort = () =>
                    authRuntimeLease.signal.removeEventListener(
                        "abort",
                        abortForAuthRotation,
                    );
                if (authRuntimeLease.signal.aborted) controller.abort();
                let publishedFileBytes = record.bytesReceived;
                let publishedFileAt = this.dependencies.now();
                record = await completeDeviceAudioDownload({
                    vault: this.dependencies.audioVault,
                    record,
                    authGeneration: authRuntimeLease.generation,
                    sourceUrl: source.absolute,
                    signal: controller.signal,
                    request: this.dependencies.fetch,
                    now: this.dependencies.now,
                    assertCurrent: () =>
                        this.assertCurrentAuthRuntime(
                            input.ownerId,
                            authRuntimeLease,
                        ),
                    onHeaders: async (
                        expected,
                        { totalBytes, contentType },
                    ) => {
                        const progressRecord = {
                            ...expected,
                            totalBytes,
                            contentType,
                            updatedAt: this.dependencies.now(),
                        };
                        await this.updateCurrent(
                            expected,
                            progressRecord,
                            isAuthorized,
                        );
                        this.notify();
                        return progressRecord;
                    },
                    onProgress: async (expected, bytes, totalBytes) => {
                        const now = this.dependencies.now();
                        const shouldPublish =
                            publishedFileBytes === 0 ||
                            bytes - publishedFileBytes >=
                                DEVICE_OFFLINE_PROGRESS_UPDATE_MIN_BYTES ||
                            now - publishedFileAt >=
                                DEVICE_OFFLINE_PROGRESS_UPDATE_INTERVAL_MS ||
                            (totalBytes !== null && bytes >= totalBytes);
                        if (!shouldPublish) return;
                        await this.publishForegroundProgress(
                            expected,
                            bytes,
                            totalBytes,
                            isAuthorized,
                        );
                        publishedFileBytes = bytes;
                        publishedFileAt = now;
                    },
                    validateCurrent: async (expected) => {
                        const current =
                            await this.dependencies.metadataStore.getByKey(key);
                        if (
                            this.deletedKeys.has(key) ||
                            !isCurrentForegroundAttempt(current, expected)
                        ) {
                            throw new StaleDeviceOfflineAttemptError();
                        }
                    },
                    publishReady: (expected, ready) =>
                        this.updateCurrent(expected, ready, isAuthorized),
                });
                this.notify();
                return record;
            }
            const backgroundCandidate: DeviceOfflineDownloadRecord = {
                ...record,
                transferMode: "background",
                backgroundFetchId: backgroundFetchIdForKey(key, record.attempt),
                foregroundLeaseExpiresAt:
                    this.dependencies.now() +
                    DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
                updatedAt: this.dependencies.now(),
            };
            await this.updateCurrent(record, backgroundCandidate, isAuthorized);
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            record = backgroundCandidate;
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            const backgroundStart = await this.dependencies
                .startBackgroundFetch(backgroundCandidate, source.absolute)
                .catch(
                    (): DeviceOfflineBackgroundFetchStartResult =>
                        "unavailable",
                );
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            if (backgroundStart === "started") {
                const confirmedBackground: DeviceOfflineDownloadRecord = {
                    ...backgroundCandidate,
                    foregroundLeaseId: null,
                    foregroundLeaseExpiresAt: null,
                    updatedAt: this.dependencies.now(),
                };
                try {
                    await this.updateCurrent(
                        backgroundCandidate,
                        confirmedBackground,
                        isAuthorized,
                    );
                } catch (error) {
                    await this.dependencies
                        .abortBackgroundFetch(backgroundCandidate)
                        .catch(() => undefined);
                    throw error;
                }
                record = confirmedBackground;
                this.notify();
                return record;
            }
            if (backgroundStart === "unknown") {
                this.scheduleLeaseExpiryCheck(backgroundCandidate);
                this.notify();
                return backgroundCandidate;
            }
            const foregroundRecord: DeviceOfflineDownloadRecord = {
                ...record,
                transferMode: "foreground",
                backgroundFetchId: null,
                foregroundLeaseId,
                foregroundLeaseExpiresAt:
                    this.dependencies.now() +
                    DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
                updatedAt: this.dependencies.now(),
            };
            await this.updateCurrent(record, foregroundRecord, isAuthorized);
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            record = foregroundRecord;
            stopLeaseHeartbeat = this.startForegroundLeaseHeartbeat(
                foregroundRecord,
                authRuntimeLease,
            );

            const controller = new AbortController();
            this.abortByKey.set(key, {
                ownerId: input.ownerId,
                controller,
            });
            const abortForAuthRotation = () => controller.abort();
            authRuntimeLease.signal.addEventListener(
                "abort",
                abortForAuthRotation,
                { once: true },
            );
            unlinkAuthAbort = () =>
                authRuntimeLease.signal.removeEventListener(
                    "abort",
                    abortForAuthRotation,
                );
            if (authRuntimeLease.signal.aborted) controller.abort();
            const fetchAudio = this.dependencies.fetch;
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            const response = await fetchAudio(source.absolute, {
                method: "GET",
                credentials: "include",
                cache: "no-store",
                signal: controller.signal,
            });
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            if (response.status !== 200) {
                throw new DeviceOfflineDownloadError(
                    "http",
                    `Не удалось скачать аудио: HTTP ${response.status}`,
                    response.status,
                );
            }

            const totalBytes = parseDeviceAudioContentLength(response);
            await assertLegacyCacheQuotaAvailable(
                this.dependencies.estimateStorage,
                totalBytes,
            );
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            const progressRecord: DeviceOfflineDownloadRecord = {
                ...record,
                totalBytes,
                contentType: response.headers.get("content-type"),
                foregroundLeaseExpiresAt:
                    this.dependencies.now() +
                    DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
                updatedAt: this.dependencies.now(),
            };
            await this.updateCurrent(record, progressRecord, isAuthorized);
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            record = progressRecord;
            this.notify();

            const absoluteVirtualUrl = new URL(
                virtualUrl,
                this.dependencies.origin,
            ).toString();
            if (response.body) {
                const [cacheBody, progressBody] = response.body.tee();
                this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
                cacheWriteSettlement = this.dependencies.audioCache
                    .put(
                        absoluteVirtualUrl,
                        createLegacyCachedAudioResponse(
                            response,
                            cacheBody,
                            totalBytes,
                        ),
                    )
                    .then(
                        () => ({ status: "fulfilled" }) as const,
                        (reason: unknown) =>
                            ({ status: "rejected", reason }) as const,
                    );
                const reader = progressBody.getReader();
                let bytesReceived = 0;
                let publishedBytes = 0;
                let publishedAt = this.dependencies.now();
                while (true) {
                    const chunk = await reader.read();
                    this.assertCurrentAuthRuntime(
                        input.ownerId,
                        authRuntimeLease,
                    );
                    if (chunk.done) break;
                    bytesReceived += chunk.value.byteLength;
                    const now = this.dependencies.now();
                    const shouldPublish =
                        publishedBytes === 0 ||
                        bytesReceived - publishedBytes >=
                            DEVICE_OFFLINE_PROGRESS_UPDATE_MIN_BYTES ||
                        now - publishedAt >=
                            DEVICE_OFFLINE_PROGRESS_UPDATE_INTERVAL_MS ||
                        (totalBytes !== null && bytesReceived >= totalBytes);
                    if (shouldPublish) {
                        await this.publishForegroundProgress(
                            record,
                            bytesReceived,
                            totalBytes,
                            isAuthorized,
                        );
                        publishedBytes = bytesReceived;
                        publishedAt = now;
                    }
                }
                if (bytesReceived > publishedBytes) {
                    await this.publishForegroundProgress(
                        record,
                        bytesReceived,
                        totalBytes,
                        isAuthorized,
                    );
                }
                const cacheWrite = await cacheWriteSettlement;
                this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
                cacheWriteSettlement = null;
                if (cacheWrite.status === "rejected") {
                    throw cacheWrite.reason;
                }
            } else {
                const bytes = await response.arrayBuffer();
                this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
                await this.publishForegroundProgress(
                    record,
                    bytes.byteLength,
                    totalBytes,
                    isAuthorized,
                );
                this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
                await this.dependencies.audioCache.put(
                    absoluteVirtualUrl,
                    createLegacyCachedAudioResponse(
                        response,
                        bytes,
                        totalBytes,
                    ),
                );
                this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            }

            if (this.deletedKeys.has(key)) {
                await this.dependencies.audioCache.delete(absoluteVirtualUrl);
                throw new DOMException("Загрузка удалена", "AbortError");
            }
            const current = await this.dependencies.metadataStore.getByKey(key);
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            if (!isCurrentForegroundAttempt(current, record)) {
                await this.dependencies.audioCache.delete(absoluteVirtualUrl);
                throw new StaleDeviceOfflineAttemptError();
            }
            const cached =
                await this.dependencies.audioCache.match(absoluteVirtualUrl);
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            if (!cached) {
                throw new DeviceOfflineDownloadError(
                    "cache",
                    "Браузер не сохранил полностью загруженный аудиофайл",
                );
            }
            const verifiedBytes = await verifyLegacyCachedAudioBytes(
                cached,
                totalBytes,
            );
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            const readyRecord: DeviceOfflineDownloadRecord = {
                ...record,
                status: "ready",
                foregroundLeaseId: null,
                foregroundLeaseExpiresAt: null,
                bytesReceived: verifiedBytes,
                totalBytes: verifiedBytes,
                integrityVersion: 1,
                errorCode: null,
                errorMessage: null,
                updatedAt: this.dependencies.now(),
            };
            await this.updateCurrent(record, readyRecord, isAuthorized);
            this.assertCurrentAuthRuntime(input.ownerId, authRuntimeLease);
            record = readyRecord;
            this.notify();
            return record;
        } catch (error) {
            const absoluteVirtualUrl = new URL(
                virtualUrl,
                this.dependencies.origin,
            ).toString();
            if (cacheWriteSettlement) {
                await cacheWriteSettlement;
                cacheWriteSettlement = null;
            }
            await this.dependencies.audioCache
                .delete(absoluteVirtualUrl)
                .catch(() => undefined);
            if (
                this.deletedKeys.has(key) ||
                error instanceof StaleDeviceOfflineAttemptError
            ) {
                throw error;
            }

            if (
                error instanceof SupersededDeviceOfflineAuthRuntimeError ||
                !isAuthorized()
            ) {
                await this.dependencies
                    .abortBackgroundFetch(record)
                    .catch(() => undefined);
                const current =
                    await this.dependencies.metadataStore.getByKey(key);
                if (
                    current?.ownerId === record.ownerId &&
                    current.attempt === record.attempt
                ) {
                    await this.dependencies.metadataStore
                        .deleteIfCurrent(current)
                        .catch(() => false);
                }
                this.notify();
                throw error instanceof SupersededDeviceOfflineAuthRuntimeError
                    ? error
                    : new SupersededDeviceOfflineAuthRuntimeError();
            }

            const failure = classifyDeviceOfflineFailure(error);
            const failureRecord: DeviceOfflineDownloadRecord = {
                ...record,
                status: failure.status,
                foregroundLeaseId: null,
                foregroundLeaseExpiresAt: null,
                errorCode: failure.code,
                errorMessage: failure.message,
                updatedAt: this.dependencies.now(),
            };
            const updated = await this.dependencies.metadataStore.putIfCurrent(
                record,
                failureRecord,
                isAuthorized,
            );
            if (!updated) throw new StaleDeviceOfflineAttemptError();
            record = failureRecord;
            this.notify();
            throw error;
        } finally {
            stopLeaseHeartbeat?.();
            unlinkAuthAbort?.();
            this.abortByKey.delete(key);
        }
    }

    async delete(
        ownerId: string,
        key: string,
        callerIsAuthorized?: () => boolean,
    ): Promise<boolean> {
        const authRuntimeLease = this.ownerLease(ownerId);
        const isAuthorized = () =>
            this.isAuthLeaseCurrent(ownerId, authRuntimeLease) &&
            (callerIsAuthorized?.() ?? true);
        const assertAuthorized = () => {
            this.assertCurrentAuthRuntime(ownerId, authRuntimeLease);
            if (!isAuthorized()) {
                throw new SupersededDeviceOfflineAuthRuntimeError();
            }
        };
        assertAuthorized();
        const record = await this.dependencies.metadataStore.getByKey(key);
        assertAuthorized();
        if (!record || record.ownerId !== ownerId) return false;

        this.deletedKeys.add(key);
        this.cancelScheduledLeaseExpiryCheck(key);
        this.abortByKey.get(key)?.controller.abort();
        const realFile = Boolean(
            record.mediaRef && this.dependencies.audioVault,
        );
        try {
            const deleted = await deleteManagedDeviceOfflineRecord(
                this.dependencies,
                record,
                {
                    authGeneration: authRuntimeLease.generation,
                    isAuthorized,
                },
                false,
            );
            if (deleted && !realFile) this.notify();
            return deleted;
        } finally {
            if (realFile) this.notify();
        }
    }

    /** Stop foreground transfers before the browser adopts another account. */
    abortOwner(ownerId: string): void {
        for (const active of this.abortByKey.values()) {
            if (active.ownerId === ownerId) active.controller.abort();
        }
    }

    /** Evict only the exact ready copy that is still automation-managed. */
    async deleteAutoManagedIfCurrent(
        ownerId: string,
        expected: DeviceOfflineDownloadRecord,
    ): Promise<boolean> {
        const authRuntimeLease = this.ownerLease(ownerId);
        const isAuthorized = () =>
            this.isAuthLeaseCurrent(ownerId, authRuntimeLease);
        this.assertCurrentAuthRuntime(ownerId, authRuntimeLease);
        if (
            expected.ownerId !== ownerId ||
            expected.status !== "ready" ||
            expected.management !== "auto-liked"
        ) {
            return false;
        }

        this.deletedKeys.add(expected.key);
        this.cancelScheduledLeaseExpiryCheck(expected.key);
        this.abortByKey.get(expected.key)?.controller.abort();
        const realFile = Boolean(
            expected.mediaRef && this.dependencies.audioVault,
        );
        try {
            const deleted = await deleteManagedDeviceOfflineRecord(
                this.dependencies,
                expected,
                {
                    authGeneration: authRuntimeLease.generation,
                    isAuthorized,
                },
                true,
            );
            if (deleted && !realFile) this.notify();
            return deleted;
        } finally {
            if (realFile) this.notify();
        }
    }

    /** Protect an auto-managed copy after an explicit user download action. */
    async promoteToManual(
        ownerId: string,
        key: string,
    ): Promise<DeviceOfflineDownloadRecord | null> {
        const authRuntimeLease = this.ownerLease(ownerId);
        const isAuthorized = () =>
            this.isAuthLeaseCurrent(ownerId, authRuntimeLease);
        const promotion = await promoteReadyDeviceOfflineRecord(
            this.dependencies,
            {
                ownerId,
                key,
                isAuthorized,
                assertAuthorized: () =>
                    this.assertCurrentAuthRuntime(ownerId, authRuntimeLease),
            },
        );
        if (promotion.changed) this.notify();
        return promotion.record;
    }

    private async updateCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<void> {
        if (
            !(await this.dependencies.metadataStore.putIfCurrent(
                expected,
                next,
                isAuthorized,
            ))
        ) {
            throw new StaleDeviceOfflineAttemptError();
        }
    }

    private ownerLease(ownerId: string): AuthRuntimeLease {
        return (
            this.ownerAuthLeases.get(ownerId)?.lease ??
            this.dependencies.getAuthRuntimeLease()
        );
    }

    private isAuthLeaseCurrent(
        ownerId: string,
        lease: AuthRuntimeLease,
    ): boolean {
        const ownerLease = this.ownerAuthLeases.get(ownerId);
        return (
            !lease.signal.aborted &&
            ownerLease?.retired !== true &&
            (ownerLease?.lease.generation ?? lease.generation) ===
                lease.generation &&
            this.dependencies.isAuthRuntimeCurrent(lease.generation)
        );
    }

    private assertCurrentAuthRuntime(
        ownerId: string,
        lease: AuthRuntimeLease,
    ): void {
        if (!this.isAuthLeaseCurrent(ownerId, lease)) {
            throw new SupersededDeviceOfflineAuthRuntimeError();
        }
    }

    private async publishForegroundProgress(
        expected: DeviceOfflineDownloadRecord,
        bytesReceived: number,
        totalBytes: number | null,
        isAuthorized?: () => boolean,
    ): Promise<void> {
        const published = await publishDeviceOfflineProgress(
            this.dependencies,
            expected,
            bytesReceived,
            totalBytes,
            DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
            isAuthorized,
        );
        if (published) this.notify();
    }

    private startForegroundLeaseHeartbeat(
        expected: DeviceOfflineDownloadRecord,
        authRuntimeLease: AuthRuntimeLease,
    ): () => void {
        let stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            this.dependencies.cancelLeaseHeartbeat(handle);
        };
        const renew = async () => {
            if (stopped) return;
            if (!this.isAuthLeaseCurrent(expected.ownerId, authRuntimeLease)) {
                stop();
                return;
            }
            const current = await this.dependencies.metadataStore.getByKey(
                expected.key,
            );
            if (!isCurrentForegroundAttempt(current, expected)) {
                stop();
                return;
            }
            const now = this.dependencies.now();
            const renewed: DeviceOfflineDownloadRecord = {
                ...current,
                foregroundLeaseExpiresAt:
                    now + DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
                updatedAt: now,
            };
            if (
                !(await this.dependencies.metadataStore.putIfCurrent(
                    current,
                    renewed,
                    () =>
                        this.isAuthLeaseCurrent(
                            expected.ownerId,
                            authRuntimeLease,
                        ),
                ))
            ) {
                stop();
            }
        };
        const handle = this.dependencies.scheduleLeaseHeartbeat(() => {
            void renew().catch(() => undefined);
        }, DEVICE_OFFLINE_FOREGROUND_HEARTBEAT_MS);
        if (stopped) this.dependencies.cancelLeaseHeartbeat(handle);
        return stop;
    }

    private async scheduleCurrentLeaseExpiryCheck(key: string): Promise<void> {
        const current = await this.dependencies.metadataStore.getByKey(key);
        if (current?.status === "downloading" && current.foregroundLeaseId) {
            this.scheduleLeaseExpiryCheck(current);
        }
    }

    private scheduleLeaseExpiryCheck(
        record: DeviceOfflineDownloadRecord,
    ): void {
        if (
            this.leaseExpiryCheckByKey.has(record.key) ||
            !record.foregroundLeaseId ||
            typeof record.foregroundLeaseExpiresAt !== "number"
        ) {
            return;
        }
        const delayMs = Math.max(
            1,
            Math.min(
                record.foregroundLeaseExpiresAt - this.dependencies.now() + 1,
                DEVICE_OFFLINE_LEASE_MAX_FUTURE_MS + 1,
            ),
        );
        const handle = this.dependencies.scheduleLeaseExpiryCheck(() => {
            if (this.leaseExpiryCheckByKey.get(record.key) !== handle) return;
            this.leaseExpiryCheckByKey.delete(record.key);
            void this.recheckLeaseExpiry(record.key).catch(() => undefined);
        }, delayMs);
        this.leaseExpiryCheckByKey.set(record.key, handle);
    }

    private cancelScheduledLeaseExpiryCheck(key: string): void {
        const handle = this.leaseExpiryCheckByKey.get(key);
        if (handle === undefined) return;
        this.leaseExpiryCheckByKey.delete(key);
        this.dependencies.cancelLeaseExpiryCheck(handle);
    }

    private async recheckLeaseExpiry(key: string): Promise<void> {
        const current = await this.dependencies.metadataStore.getByKey(key);
        if (current?.status !== "downloading" || !current.foregroundLeaseId) {
            return;
        }
        if (current.transferMode === "background") {
            const reconciled = await this.reconcile(current.ownerId);
            const refreshed = reconciled.find((record) => record.key === key);
            if (
                refreshed?.status !== "downloading" ||
                !refreshed.foregroundLeaseId
            ) {
                this.notify();
                return;
            }

            const now = this.dependencies.now();
            if (foregroundLeaseDisposition(refreshed, now) === "expired") {
                // Reconcile leaves an expired background verification lease
                // untouched only when registration enumeration is unknown.
                // Preserve that uncertainty for one bounded retry instead of
                // declaring a potentially active browser transfer ended.
                const retry =
                    backgroundLeaseRetry(
                        refreshed.foregroundLeaseId,
                        DEVICE_OFFLINE_BACKGROUND_UNKNOWN_LEASE_PREFIX,
                    ) + 1;
                if (retry > DEVICE_OFFLINE_BACKGROUND_UNKNOWN_RETRY_LIMIT) {
                    if (
                        await this.dependencies.metadataStore.interruptForegroundIfLeaseExpired(
                            refreshed,
                            now,
                        )
                    ) {
                        this.notify();
                    }
                    return;
                }
                const extended: DeviceOfflineDownloadRecord = {
                    ...refreshed,
                    foregroundLeaseId: `${DEVICE_OFFLINE_BACKGROUND_UNKNOWN_LEASE_PREFIX}${retry}:${refreshed.backgroundFetchId ?? refreshed.key}`,
                    foregroundLeaseExpiresAt:
                        now + DEVICE_OFFLINE_BACKGROUND_MISSING_GRACE_MS,
                    updatedAt: now,
                };
                if (
                    await this.dependencies.metadataStore.putIfCurrent(
                        refreshed,
                        extended,
                    )
                ) {
                    this.scheduleLeaseExpiryCheck(extended);
                }
                return;
            }
            await this.scheduleCurrentLeaseExpiryCheck(key);
            return;
        }
        const interrupted =
            await this.dependencies.metadataStore.interruptForegroundIfLeaseExpired(
                current,
                this.dependencies.now(),
            );
        if (interrupted) {
            this.notify();
            return;
        }
        await this.scheduleCurrentLeaseExpiryCheck(key);
    }
}
