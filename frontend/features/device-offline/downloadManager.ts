import {
    backgroundFetchIdForKey,
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

const STREAM_SOURCE_PATHS = [
    /^\/api\/library\/tracks\/[^/]+\/stream\/?$/,
    /^\/api\/artists\/preview-stream\/[^/]+\/?$/,
    /^\/api\/ytmusic\/(?:stream|stream-public)\/[^/]+\/?$/,
    /^\/api\/youtube\/stream\/[^/]+\/?$/,
    /^\/api\/tidal-streaming\/stream\/[^/]+\/?$/,
    /^\/api\/audiobooks\/[^/]+\/stream\/?$/,
    /^\/api\/podcasts\/[^/]+\/episodes\/[^/]+\/stream\/?$/,
];
const SENSITIVE_QUERY_NAMES = new Set([
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
]);
export const DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS = 30_000;
export const DEVICE_OFFLINE_FOREGROUND_HEARTBEAT_MS = 10_000;
export const DEVICE_OFFLINE_BACKGROUND_MISSING_GRACE_MS = 10_000;
export const DEVICE_OFFLINE_BACKGROUND_LOOKUP_TIMEOUT_MS = 1_500;
export const DEVICE_OFFLINE_BACKGROUND_UNKNOWN_RETRY_LIMIT = 3;
const DEVICE_OFFLINE_LEASE_MAX_FUTURE_MS = 5 * 60_000;
const DEVICE_OFFLINE_LEGACY_FOREGROUND_GRACE_MS = 30_000;
const DEVICE_OFFLINE_BACKGROUND_UNKNOWN_LEASE_PREFIX = "background-unknown:";

function backgroundUnknownLeaseRetry(leaseId: string): number {
    if (!leaseId.startsWith(DEVICE_OFFLINE_BACKGROUND_UNKNOWN_LEASE_PREFIX)) {
        return 0;
    }
    const retry = Number(
        leaseId
            .slice(DEVICE_OFFLINE_BACKGROUND_UNKNOWN_LEASE_PREFIX.length)
            .split(":", 1)[0],
    );
    return Number.isSafeInteger(retry) && retry > 0 ? retry : 0;
}

export type ForegroundLeaseDisposition = "live" | "clamp" | "expired";

export function foregroundLeaseDisposition(
    record: DeviceOfflineDownloadRecord,
    now: number,
): ForegroundLeaseDisposition {
    const leaseId = record.foregroundLeaseId;
    const expiresAt =
        typeof record.foregroundLeaseExpiresAt === "number"
            ? record.foregroundLeaseExpiresAt
            : Number.NaN;
    if (
        typeof leaseId === "string" &&
        leaseId.length > 0 &&
        Number.isFinite(expiresAt)
    ) {
        const remaining = expiresAt - now;
        if (remaining > DEVICE_OFFLINE_LEASE_MAX_FUTURE_MS) return "clamp";
        return remaining > 0 ? "live" : "expired";
    }

    const age = now - Number(record.updatedAt);
    if (!Number.isFinite(age)) return "expired";
    if (age < -DEVICE_OFFLINE_LEASE_MAX_FUTURE_MS) return "clamp";
    return age <= DEVICE_OFFLINE_LEGACY_FOREGROUND_GRACE_MS
        ? "live"
        : "expired";
}

export function clampForegroundLeaseClockSkew(
    record: DeviceOfflineDownloadRecord,
    now: number,
): DeviceOfflineDownloadRecord {
    return {
        ...record,
        ...(record.foregroundLeaseId
            ? {
                  foregroundLeaseExpiresAt:
                      now + DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
              }
            : {}),
        updatedAt: now,
    };
}

export function interruptExpiredForegroundRecord(
    record: DeviceOfflineDownloadRecord,
    now: number,
): DeviceOfflineDownloadRecord {
    return {
        ...record,
        status: "interrupted",
        backgroundFetchId:
            record.transferMode === "background"
                ? null
                : record.backgroundFetchId,
        foregroundLeaseId: null,
        foregroundLeaseExpiresAt: null,
        errorCode: "interrupted",
        errorMessage:
            "The download was interrupted. Resume restarts this track transfer.",
        updatedAt: now,
    };
}

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
    ): Promise<boolean>;
    put(record: DeviceOfflineDownloadRecord): Promise<void>;
    putIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
    ): Promise<boolean>;
    interruptForegroundIfLeaseExpired(
        expected: DeviceOfflineDownloadRecord,
        now: number,
    ): Promise<boolean>;
    deleteIfCurrent(expected: DeviceOfflineDownloadRecord): Promise<boolean>;
}

export interface DeviceOfflineAudioCache {
    put(url: string, response: Response): Promise<void>;
    match(url: string): Promise<Response | null>;
    delete(url: string): Promise<void>;
}

export interface DeviceOfflineManagerDependencies {
    metadataStore: DeviceOfflineMetadataStore;
    audioCache: DeviceOfflineAudioCache;
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
    ) => Promise<void>;
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
}

type DeviceOfflineListener = () => void;

class DeviceOfflineDownloadError extends Error {
    constructor(
        readonly code: "http" | "quota" | "cache" | "invalid_source",
        message: string,
    ) {
        super(message);
        this.name = "DeviceOfflineDownloadError";
    }
}

class StaleDeviceOfflineAttemptError extends Error {
    constructor() {
        super("Device download was superseded or deleted");
        this.name = "StaleDeviceOfflineAttemptError";
    }
}

function isCurrentForegroundAttempt(
    current: DeviceOfflineDownloadRecord | null,
    expected: DeviceOfflineDownloadRecord,
): current is DeviceOfflineDownloadRecord {
    return (
        current?.key === expected.key &&
        current.ownerId === expected.ownerId &&
        current.attempt === expected.attempt &&
        current.status === "downloading" &&
        current.transferMode === "foreground" &&
        (current.foregroundLeaseId ?? null) ===
            (expected.foregroundLeaseId ?? null)
    );
}

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
        (current.foregroundLeaseId ?? null) ===
            (expected.foregroundLeaseId ?? null)
    );
}

function normalizeSourceUrl(
    sourceUrl: string,
    origin: string,
): { absolute: string; stored: string } {
    const parsed = new URL(sourceUrl, origin);
    if (parsed.origin !== new URL(origin).origin) {
        throw new DeviceOfflineDownloadError(
            "invalid_source",
            "Device downloads require a same-origin audio URL",
        );
    }
    for (const name of parsed.searchParams.keys()) {
        if (SENSITIVE_QUERY_NAMES.has(name.toLowerCase())) {
            throw new DeviceOfflineDownloadError(
                "invalid_source",
                "Device download URL contains a credential",
            );
        }
    }
    if (!STREAM_SOURCE_PATHS.some((pattern) => pattern.test(parsed.pathname))) {
        throw new DeviceOfflineDownloadError(
            "invalid_source",
            "Device download URL is not an approved audio route",
        );
    }
    return {
        absolute: parsed.toString(),
        stored: `${parsed.pathname}${parsed.search}`,
    };
}

function parseContentLength(response: Response): number | null {
    const raw = response.headers.get("content-length");
    if (raw === null || raw.trim() === "") return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function classifyFailure(error: unknown): {
    status: "interrupted" | "error";
    code: string;
    message: string;
} {
    const message =
        error instanceof Error
            ? error.message
            : String(error ?? "Download failed");
    if (error instanceof DeviceOfflineDownloadError) {
        return { status: "error", code: error.code, message };
    }
    if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "NetworkError")
    ) {
        return { status: "interrupted", code: "interrupted", message };
    }
    if (error instanceof TypeError) {
        return { status: "interrupted", code: "network", message };
    }
    const quotaName =
        error && typeof error === "object" && "name" in error
            ? String((error as { name: unknown }).name)
            : "";
    if (quotaName === "QuotaExceededError") {
        return { status: "error", code: "quota", message };
    }
    return { status: "error", code: "cache", message };
}

function createCachedAudioResponse(
    response: Response,
    body: BodyInit | null,
    totalBytes: number | null,
): Response {
    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    if (totalBytes !== null) {
        headers.set("content-length", String(totalBytes));
    }
    headers.set("accept-ranges", "bytes");
    const etag = response.headers.get("etag");
    if (etag) headers.set("etag", etag);
    const lastModified = response.headers.get("last-modified");
    if (lastModified) headers.set("last-modified", lastModified);
    return new Response(body, { status: 200, headers });
}

async function assertQuotaAvailable(
    dependencies: DeviceOfflineManagerDependencies,
    totalBytes: number | null,
): Promise<void> {
    if (totalBytes === null || totalBytes === 0) return;
    const estimate = await dependencies.estimateStorage();
    if (!estimate) return;
    const quota = Number(estimate.quota);
    const usage = Number(estimate.usage);
    if (!Number.isFinite(quota) || !Number.isFinite(usage)) return;
    if (Math.max(0, quota - usage) < totalBytes) {
        throw new DeviceOfflineDownloadError(
            "quota",
            "Not enough device storage for this track",
        );
    }
}

/** Coordinates one-track foreground/background downloads without server jobs. */
export class DeviceOfflineDownloadManager {
    private readonly listeners = new Set<DeviceOfflineListener>();
    private readonly inFlightByIdentity = new Map<
        string,
        Promise<DeviceOfflineDownloadRecord>
    >();
    private readonly abortByKey = new Map<string, AbortController>();
    private readonly deletedKeys = new Set<string>();
    private readonly leaseExpiryCheckByKey = new Map<string, unknown>();

    constructor(
        private readonly dependencies: DeviceOfflineManagerDependencies,
    ) {}

    subscribe(listener: DeviceOfflineListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(): void {
        for (const listener of this.listeners) listener();
    }

    async list(ownerId: string): Promise<DeviceOfflineDownloadRecord[]> {
        const records =
            await this.dependencies.metadataStore.listByOwner(ownerId);
        return records.sort((left, right) => right.updatedAt - left.updatedAt);
    }

    async reconcile(ownerId: string): Promise<DeviceOfflineDownloadRecord[]> {
        const records = await this.list(ownerId);
        let activeBackgroundIds: Set<string> | null = null;
        try {
            const backgroundFetchLookup =
                this.dependencies.listActiveBackgroundFetches();
            activeBackgroundIds = new Set(
                await new Promise<string[]>((resolve, reject) => {
                    const timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    "Background Fetch enumeration timed out",
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

        for (const record of records) {
            let next: DeviceOfflineDownloadRecord | null = null;
            if (record.status === "ready") {
                const absoluteVirtualUrl = new URL(
                    record.virtualUrl,
                    this.dependencies.origin,
                ).toString();
                if (
                    !(await this.dependencies.audioCache.match(
                        absoluteVirtualUrl,
                    ))
                ) {
                    next = {
                        ...record,
                        status: "interrupted",
                        errorCode: "cache_missing",
                        errorMessage:
                            "The browser evicted this device copy. Resume to download it again.",
                        updatedAt: this.dependencies.now(),
                    };
                }
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
                activeBackgroundIds?.has(record.backgroundFetchId) &&
                record.foregroundLeaseId
            ) {
                next = {
                    ...record,
                    foregroundLeaseId: null,
                    foregroundLeaseExpiresAt: null,
                    updatedAt: this.dependencies.now(),
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
                        "The download was interrupted. Resume restarts this track transfer.",
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
                }
            }
        }
        return this.list(ownerId);
    }

    download(
        input: DeviceOfflineDownloadInput,
    ): Promise<DeviceOfflineDownloadRecord> {
        const quality = normalizeDeviceOfflineQuality(input.quality);
        const trackIdentity = resolveDeviceOfflineTrackIdentity(input.track);
        const inFlightKey = `${input.ownerId}\u0000${trackIdentity}\u0000${quality}`;
        const existing = this.inFlightByIdentity.get(inFlightKey);
        if (existing) return existing;

        const promise = this.runDownload({
            ...input,
            quality,
        }).finally(() => {
            this.inFlightByIdentity.delete(inFlightKey);
        });
        this.inFlightByIdentity.set(inFlightKey, promise);
        return promise;
    }

    private async runDownload(
        input: DeviceOfflineDownloadInput & { quality: string },
    ): Promise<DeviceOfflineDownloadRecord> {
        const source = normalizeSourceUrl(
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
        const key = this.dependencies.createKey();
        const virtualUrl = buildDeviceOfflineVirtualUrl(key);
        const attempt = (previous?.attempt ?? 0) + 1;
        const foregroundLeaseId = `${key}:${attempt}`;
        const persistenceGranted = await this.dependencies
            .requestPersistentStorage()
            .catch(() => null);
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
        );
        if (!claimed) throw new StaleDeviceOfflineAttemptError();
        if (previous) {
            await Promise.allSettled([
                this.dependencies.abortBackgroundFetch(previous),
                this.dependencies.audioCache.delete(
                    new URL(
                        previous.virtualUrl,
                        this.dependencies.origin,
                    ).toString(),
                ),
            ]);
        }
        this.notify();

        let stopLeaseHeartbeat: (() => void) | null = null;
        let cacheWriteSettlement: Promise<
            { status: "fulfilled" } | { status: "rejected"; reason: unknown }
        > | null = null;
        try {
            const backgroundCandidate: DeviceOfflineDownloadRecord = {
                ...record,
                transferMode: "background",
                backgroundFetchId: backgroundFetchIdForKey(key, record.attempt),
                foregroundLeaseExpiresAt:
                    this.dependencies.now() +
                    DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
                updatedAt: this.dependencies.now(),
            };
            await this.updateCurrent(record, backgroundCandidate);
            record = backgroundCandidate;
            const backgroundStart = await this.dependencies
                .startBackgroundFetch(backgroundCandidate, source.absolute)
                .catch(
                    (): DeviceOfflineBackgroundFetchStartResult =>
                        "unavailable",
                );
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
            await this.updateCurrent(record, foregroundRecord);
            record = foregroundRecord;
            stopLeaseHeartbeat =
                this.startForegroundLeaseHeartbeat(foregroundRecord);

            const controller = new AbortController();
            this.abortByKey.set(key, controller);
            const fetchAudio = this.dependencies.fetch;
            const response = await fetchAudio(source.absolute, {
                method: "GET",
                credentials: "include",
                cache: "no-store",
                signal: controller.signal,
            });
            if (response.status !== 200) {
                throw new DeviceOfflineDownloadError(
                    "http",
                    `Audio download failed with HTTP ${response.status}`,
                );
            }

            const totalBytes = parseContentLength(response);
            await assertQuotaAvailable(this.dependencies, totalBytes);
            const progressRecord: DeviceOfflineDownloadRecord = {
                ...record,
                totalBytes,
                contentType: response.headers.get("content-type"),
                foregroundLeaseExpiresAt:
                    this.dependencies.now() +
                    DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
                updatedAt: this.dependencies.now(),
            };
            await this.updateCurrent(record, progressRecord);
            record = progressRecord;
            this.notify();

            const absoluteVirtualUrl = new URL(
                virtualUrl,
                this.dependencies.origin,
            ).toString();
            let received = 0;
            if (response.body) {
                const [cacheBody, progressBody] = response.body.tee();
                cacheWriteSettlement = this.dependencies.audioCache
                    .put(
                        absoluteVirtualUrl,
                        createCachedAudioResponse(
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
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    received += chunk.value?.byteLength ?? 0;
                }
                const cacheWrite = await cacheWriteSettlement;
                cacheWriteSettlement = null;
                if (cacheWrite.status === "rejected") {
                    throw cacheWrite.reason;
                }
            } else {
                const bytes = await response.arrayBuffer();
                received = bytes.byteLength;
                await this.dependencies.audioCache.put(
                    absoluteVirtualUrl,
                    createCachedAudioResponse(response, bytes, totalBytes),
                );
            }

            if (this.deletedKeys.has(key)) {
                await this.dependencies.audioCache.delete(absoluteVirtualUrl);
                throw new DOMException("Download deleted", "AbortError");
            }
            const current = await this.dependencies.metadataStore.getByKey(key);
            if (!isCurrentForegroundAttempt(current, record)) {
                await this.dependencies.audioCache.delete(absoluteVirtualUrl);
                throw new StaleDeviceOfflineAttemptError();
            }
            const cached =
                await this.dependencies.audioCache.match(absoluteVirtualUrl);
            if (!cached) {
                throw new DeviceOfflineDownloadError(
                    "cache",
                    "The browser did not retain the completed audio response",
                );
            }
            const readyRecord: DeviceOfflineDownloadRecord = {
                ...record,
                status: "ready",
                foregroundLeaseId: null,
                foregroundLeaseExpiresAt: null,
                bytesReceived: totalBytes ?? received,
                totalBytes: totalBytes ?? received,
                errorCode: null,
                errorMessage: null,
                updatedAt: this.dependencies.now(),
            };
            await this.updateCurrent(record, readyRecord);
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
            await this.dependencies.audioCache.delete(absoluteVirtualUrl);
            if (
                this.deletedKeys.has(key) ||
                error instanceof StaleDeviceOfflineAttemptError
            ) {
                throw error;
            }

            const failure = classifyFailure(error);
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
            );
            if (!updated) throw new StaleDeviceOfflineAttemptError();
            record = failureRecord;
            this.notify();
            throw error;
        } finally {
            stopLeaseHeartbeat?.();
            this.abortByKey.delete(key);
        }
    }

    async delete(ownerId: string, key: string): Promise<boolean> {
        const record = await this.dependencies.metadataStore.getByKey(key);
        if (!record || record.ownerId !== ownerId) return false;

        this.deletedKeys.add(key);
        this.cancelScheduledLeaseExpiryCheck(key);
        this.abortByKey.get(key)?.abort();
        const deleted =
            await this.dependencies.metadataStore.deleteIfCurrent(record);
        if (!deleted) return false;
        await this.dependencies
            .abortBackgroundFetch(record)
            .catch(() => undefined);
        await this.dependencies.audioCache.delete(
            new URL(record.virtualUrl, this.dependencies.origin).toString(),
        );
        this.notify();
        return true;
    }

    private async updateCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
    ): Promise<void> {
        if (
            !(await this.dependencies.metadataStore.putIfCurrent(
                expected,
                next,
            ))
        ) {
            throw new StaleDeviceOfflineAttemptError();
        }
    }

    private startForegroundLeaseHeartbeat(
        expected: DeviceOfflineDownloadRecord,
    ): () => void {
        let stopped = false;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            this.dependencies.cancelLeaseHeartbeat(handle);
        };
        const renew = async () => {
            if (stopped) return;
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
                    backgroundUnknownLeaseRetry(refreshed.foregroundLeaseId) +
                    1;
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
