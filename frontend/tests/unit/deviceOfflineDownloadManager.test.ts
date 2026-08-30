import assert from "node:assert/strict";
import test from "node:test";
import {
    clampForegroundLeaseClockSkew,
    DEVICE_OFFLINE_BACKGROUND_MISSING_GRACE_MS,
    DEVICE_OFFLINE_BACKGROUND_STALL_MS,
    DEVICE_OFFLINE_BACKGROUND_UNKNOWN_RETRY_LIMIT,
    DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
    DeviceOfflineDownloadManager,
    foregroundLeaseDisposition,
    interruptExpiredForegroundRecord,
    matchesDeviceOfflineRecordVersion,
    mergeConcurrentDeviceOfflineUpdate,
    type DeviceOfflineAudioCache,
    type DeviceOfflineManagerDependencies,
    type DeviceOfflineMetadataStore,
} from "../../features/device-offline/downloadManager";
import {
    clearDeviceOfflineRuntimeState,
    resolveDeviceOfflinePlaybackUrl,
    setDeviceOfflineRuntimeState,
} from "../../features/device-offline/playbackResolver";
import type {
    DeviceOfflineDownloadRecord,
    DeviceOfflineTrack,
} from "../../features/device-offline/types";
import {
    DeviceAudioVaultError,
    type DeviceAudioAccessRequest,
    type DeviceAudioAccessResult,
    type DeviceAudioRetainInput,
    type DeviceAudioVault,
    type DeviceAudioVaultRef,
    type DeviceAudioVaultSession,
} from "../../features/device-offline/vault/types";

const TRACK: DeviceOfflineTrack = {
    id: "track-1",
    title: "Offline song",
    artist: { id: "artist-1", name: "Artist" },
    album: {
        id: "album-1",
        title: "Album",
        coverArt: "cover-1",
    },
    duration: 180,
};

class MemoryMetadataStore implements DeviceOfflineMetadataStore {
    readonly records = new Map<string, DeviceOfflineDownloadRecord>();

    async listByOwner(ownerId: string): Promise<DeviceOfflineDownloadRecord[]> {
        return [...this.records.values()].filter(
            (record) => record.ownerId === ownerId,
        );
    }

    async getByKey(key: string): Promise<DeviceOfflineDownloadRecord | null> {
        return this.records.get(key) ?? null;
    }

    async getByTrackQuality(
        ownerId: string,
        trackIdentity: string,
        quality: string,
    ): Promise<DeviceOfflineDownloadRecord | null> {
        return (
            [...this.records.values()].find(
                (record) =>
                    record.ownerId === ownerId &&
                    record.trackIdentity === trackIdentity &&
                    record.quality === quality,
            ) ?? null
        );
    }

    async put(record: DeviceOfflineDownloadRecord): Promise<void> {
        this.records.set(record.key, structuredClone(record));
    }

    async claimReplacement(
        expected: DeviceOfflineDownloadRecord | null,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        const current =
            [...this.records.values()].find(
                (record) =>
                    record.ownerId === next.ownerId &&
                    record.trackIdentity === next.trackIdentity &&
                    record.quality === next.quality,
            ) ?? null;
        const canClaim = expected
            ? matchesDeviceOfflineRecordVersion(current, expected)
            : current === null;
        if (!canClaim) return false;
        if (current) this.records.delete(current.key);
        this.records.set(next.key, structuredClone(next));
        return true;
    }

    async putIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        if (
            !matchesDeviceOfflineRecordVersion(
                this.records.get(expected.key) ?? null,
                expected,
            )
        ) {
            return false;
        }
        const current = this.records.get(expected.key);
        assert.ok(current);
        await this.put(mergeConcurrentDeviceOfflineUpdate(current, next));
        return true;
    }

    async putAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        const current = this.records.get(expected.key) ?? null;
        if (
            current?.management !== "auto-liked" ||
            expected.management !== "auto-liked" ||
            !matchesDeviceOfflineRecordVersion(current, expected)
        ) {
            return false;
        }
        await this.put(mergeConcurrentDeviceOfflineUpdate(current, next));
        return true;
    }

    async interruptForegroundIfLeaseExpired(
        expected: DeviceOfflineDownloadRecord,
        now: number,
    ): Promise<boolean> {
        const current = this.records.get(expected.key) ?? null;
        if (
            !current ||
            !matchesDeviceOfflineRecordVersion(current, expected) ||
            current.status !== "downloading"
        ) {
            return false;
        }
        const disposition = foregroundLeaseDisposition(current, now);
        if (disposition === "live") return false;
        if (disposition === "clamp") {
            await this.put(clampForegroundLeaseClockSkew(current, now));
            return false;
        }
        await this.put(interruptExpiredForegroundRecord(current, now));
        return true;
    }

    async deleteIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        if (
            !matchesDeviceOfflineRecordVersion(
                this.records.get(expected.key) ?? null,
                expected,
            )
        ) {
            return false;
        }
        return this.records.delete(expected.key);
    }

    async deleteAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (isAuthorized && !isAuthorized()) return false;
        const current = this.records.get(expected.key) ?? null;
        if (
            current?.management !== "auto-liked" ||
            expected.management !== "auto-liked" ||
            !matchesDeviceOfflineRecordVersion(current, expected)
        ) {
            return false;
        }
        return this.records.delete(expected.key);
    }
}

class MemoryAudioCache implements DeviceOfflineAudioCache {
    readonly responses = new Map<string, Response>();
    putCalls = 0;

    async put(url: string, response: Response): Promise<void> {
        this.putCalls += 1;
        this.responses.set(url, response.clone());
        await response.arrayBuffer();
    }

    async match(url: string): Promise<Response | null> {
        return this.responses.get(url)?.clone() ?? null;
    }

    async delete(url: string): Promise<void> {
        this.responses.delete(url);
    }
}

class MemoryDeviceAudioVault implements DeviceAudioVault {
    readonly files = new Map<DeviceAudioVaultRef, Uint8Array>();
    readonly removed: DeviceAudioVaultRef[] = [];
    failRemove = false;
    retainCalls = 0;
    readonly retainStarted: Promise<void>;
    private signalRetainStarted!: () => void;
    private releaseRetain: (() => void) | null = null;
    private readonly retainGate: Promise<void> | null;
    private sequence = 0;

    constructor(
        paused = false,
        private readonly isAuthGenerationCurrent: (
            generation: number,
        ) => boolean = () => true,
        private readonly persistenceGranted: boolean | null = true,
    ) {
        this.retainStarted = new Promise((resolve) => {
            this.signalRetainStarted = resolve;
        });
        this.retainGate = paused
            ? new Promise<void>((resolve) => {
                  this.releaseRetain = resolve;
              })
            : null;
    }

    async inspectAccess() {
        return {
            status: "ready" as const,
            code: null,
            storageKind: "desktop-directory" as const,
            label: "Soundspan Music",
            reason: "Music files are stored in the selected folder.",
        };
    }

    requestAccess() {
        return this.inspectAccess();
    }

    async open(input: {
        ownerId: string;
        authGeneration: number;
    }): Promise<DeviceAudioVaultSession> {
        return {
            ownerId: input.ownerId,
            authGeneration: input.authGeneration,
            storage: {
                kind: "desktop-directory" as const,
                label: "Soundspan Music",
            },
            retain: async (request: DeviceAudioRetainInput) => {
                this.retainCalls += 1;
                const reader = request.stream.getReader();
                const chunks: Uint8Array[] = [];
                let bytes = 0;
                while (true) {
                    if (request.signal?.aborted) {
                        throw new DeviceAudioVaultError(
                            "interrupted",
                            "Download interrupted",
                            "retry",
                        );
                    }
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    chunks.push(Uint8Array.from(chunk.value));
                    bytes += chunk.value.byteLength;
                    request.onProgress?.(bytes, request.expectedBytes ?? null);
                }
                this.signalRetainStarted();
                await this.retainGate;
                if (
                    request.expectedBytes != null &&
                    bytes !== request.expectedBytes
                ) {
                    throw new DeviceAudioVaultError(
                        "integrity",
                        "Incomplete device file",
                        "retry",
                    );
                }
                const stored = new Uint8Array(bytes);
                let offset = 0;
                for (const chunk of chunks) {
                    stored.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                const ref =
                    `test-vault:${input.ownerId}:${++this.sequence}` as DeviceAudioVaultRef;
                this.files.set(ref, stored);
                return {
                    ref,
                    bytes,
                    contentType: request.contentType,
                    displayName: `track-${this.sequence}.mp3`,
                    persistenceGranted: this.persistenceGranted,
                    discard: async () => {
                        this.removed.push(ref);
                        this.files.delete(ref);
                    },
                };
            },
            access: async <T extends DeviceAudioAccessRequest>(
                request: T,
            ): Promise<DeviceAudioAccessResult<T>> => {
                if (!this.isAuthGenerationCurrent(input.authGeneration)) {
                    throw new DeviceAudioVaultError(
                        "auth_changed",
                        "Authentication session changed",
                        "none",
                    );
                }
                if (request.kind === "remove") {
                    if (this.failRemove) {
                        throw new DeviceAudioVaultError(
                            "io",
                            "Device file removal failed",
                            "retry",
                        );
                    }
                    this.removed.push(request.ref);
                    return {
                        kind: "remove" as const,
                        removed: this.files.delete(request.ref),
                    } as DeviceAudioAccessResult<T>;
                }
                const bytes = this.files.get(request.ref);
                if (request.kind === "inspect") {
                    return {
                        kind: "inspect" as const,
                        exists: Boolean(bytes),
                        bytes: bytes?.byteLength ?? null,
                    } as DeviceAudioAccessResult<T>;
                }
                if (!bytes) {
                    throw new DeviceAudioVaultError(
                        "not_found",
                        "Device file is missing",
                        "retry",
                    );
                }
                return {
                    kind: "play" as const,
                    url: "blob:test-vault",
                    release: () => undefined,
                } as DeviceAudioAccessResult<T>;
            },
        };
    }

    resumeRetain(): void {
        this.releaseRetain?.();
    }
}

class PausedAudioCache extends MemoryAudioCache {
    putStarted: Promise<void>;
    private signalPutStarted!: () => void;
    private releasePut!: () => void;
    private readonly putRelease: Promise<void>;

    constructor() {
        super();
        this.putStarted = new Promise((resolve) => {
            this.signalPutStarted = resolve;
        });
        this.putRelease = new Promise((resolve) => {
            this.releasePut = resolve;
        });
    }

    override async put(url: string, response: Response): Promise<void> {
        await super.put(url, response);
        this.signalPutStarted();
        await this.putRelease;
    }

    resumePut(): void {
        this.releasePut();
    }
}

class DelayedFailingAudioCache extends MemoryAudioCache {
    readonly putStarted: Promise<void>;
    deleteCalls = 0;
    deleteBeforePutSettled = false;
    private signalPutStarted!: () => void;
    private releasePut!: () => void;
    private readonly putRelease: Promise<void>;
    private putSettled = false;

    constructor() {
        super();
        this.putStarted = new Promise((resolve) => {
            this.signalPutStarted = resolve;
        });
        this.putRelease = new Promise((resolve) => {
            this.releasePut = resolve;
        });
    }

    override put(_url: string, _response: Response): Promise<void> {
        const operation = (async () => {
            this.signalPutStarted();
            await this.putRelease;
            this.putSettled = true;
            throw new Error("device cache write failed");
        })();
        // The test observes manager ordering, not Node's process-level
        // unhandled-rejection policy.
        void operation.catch(() => undefined);
        return operation;
    }

    override async delete(url: string): Promise<void> {
        this.deleteCalls += 1;
        if (!this.putSettled) this.deleteBeforePutSettled = true;
        await super.delete(url);
    }

    failPut(): void {
        this.releasePut();
    }
}

class PausedConditionalMetadataStore extends MemoryMetadataStore {
    readonly updateStarted: Promise<void>;
    private signalUpdateStarted!: () => void;
    private releaseUpdate!: () => void;
    private readonly updateRelease: Promise<void>;

    constructor(
        private readonly shouldPause: (
            next: DeviceOfflineDownloadRecord,
        ) => boolean,
    ) {
        super();
        this.updateStarted = new Promise((resolve) => {
            this.signalUpdateStarted = resolve;
        });
        this.updateRelease = new Promise((resolve) => {
            this.releaseUpdate = resolve;
        });
    }

    override async putIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
    ): Promise<boolean> {
        if (this.shouldPause(next)) {
            this.signalUpdateStarted();
            await this.updateRelease;
        }
        return super.putIfCurrent(expected, next);
    }

    resumeUpdate(): void {
        this.releaseUpdate();
    }
}

class CoordinatedReadMetadataStore extends MemoryMetadataStore {
    private readCount = 0;
    private releaseReads!: () => void;
    private readonly readsReleased = new Promise<void>((resolve) => {
        this.releaseReads = resolve;
    });

    override async getByTrackQuality(
        ownerId: string,
        trackIdentity: string,
        quality: string,
    ): Promise<DeviceOfflineDownloadRecord | null> {
        const snapshot = await super.getByTrackQuality(
            ownerId,
            trackIdentity,
            quality,
        );
        this.readCount += 1;
        if (this.readCount === 2) this.releaseReads();
        await this.readsReleased;
        return snapshot ? structuredClone(snapshot) : null;
    }
}

class PausedAutoManagedClaimMetadataStore extends MemoryMetadataStore {
    readonly claimStarted: Promise<void>;
    private signalClaimStarted!: () => void;
    private releaseClaim!: () => void;
    private readonly claimRelease: Promise<void>;

    constructor() {
        super();
        this.claimStarted = new Promise((resolve) => {
            this.signalClaimStarted = resolve;
        });
        this.claimRelease = new Promise((resolve) => {
            this.releaseClaim = resolve;
        });
    }

    override async putAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        this.signalClaimStarted();
        await this.claimRelease;
        return super.putAutoManagedIfCurrent(expected, next, isAuthorized);
    }

    resumeClaim(): void {
        this.releaseClaim();
    }
}

class ProgressCountingMetadataStore extends MemoryMetadataStore {
    progressWrites = 0;

    override async putIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean> {
        if (
            next.status === "downloading" &&
            next.bytesReceived > expected.bytesReceived
        ) {
            this.progressWrites += 1;
        }
        return super.putIfCurrent(expected, next, isAuthorized);
    }
}

function createDependencies(
    overrides: Partial<DeviceOfflineManagerDependencies> = {},
): DeviceOfflineManagerDependencies & {
    metadataStore: MemoryMetadataStore;
    audioCache: MemoryAudioCache;
} {
    const metadataStore = new MemoryMetadataStore();
    const audioCache = new MemoryAudioCache();
    const defaultAuthController = new AbortController();
    let keySequence = 0;
    return {
        fetch: async () =>
            new Response(Uint8Array.from([0, 1, 2, 3, 4, 5]), {
                status: 200,
                headers: {
                    "content-type": "audio/mpeg",
                    "content-length": "6",
                },
            }),
        now: () => 1_700_000_000_000 + keySequence,
        createKey: () => `opaque-key-${++keySequence}`,
        origin: "https://soundspan.test",
        requestPersistentStorage: async () => true,
        estimateStorage: async () => ({
            usage: 100,
            quota: 10_000_000,
        }),
        startBackgroundFetch: async () => "unavailable",
        abortBackgroundFetch: async () => "cleared",
        listActiveBackgroundFetches: async () => [],
        scheduleLeaseHeartbeat: () => Symbol("lease-heartbeat"),
        cancelLeaseHeartbeat: () => undefined,
        scheduleLeaseExpiryCheck: () => Symbol("lease-expiry-check"),
        cancelLeaseExpiryCheck: () => undefined,
        getAuthRuntimeLease: () => ({
            generation: 0,
            signal: defaultAuthController.signal,
        }),
        isAuthRuntimeCurrent: (generation) => generation === 0,
        ...overrides,
        metadataStore: overrides.metadataStore ?? metadataStore,
        audioCache: overrides.audioCache ?? audioCache,
    } as DeviceOfflineManagerDependencies & {
        metadataStore: MemoryMetadataStore;
        audioCache: MemoryAudioCache;
    };
}

test("an auth-runtime replacement during persistence setup cannot fetch or retain another account's audio", async () => {
    let runtimeGeneration = 1;
    const runtimeController = new AbortController();
    let signalPersistenceStarted!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
        signalPersistenceStarted = resolve;
    });
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
    });
    let fetches = 0;
    const deps = createDependencies({
        getAuthRuntimeLease: () => ({
            generation: runtimeGeneration,
            signal: runtimeController.signal,
        }),
        isAuthRuntimeCurrent: (generation) => generation === runtimeGeneration,
        requestPersistentStorage: async () => {
            signalPersistenceStarted();
            await persistenceGate;
            return true;
        },
        fetch: async () => {
            fetches += 1;
            return new Response("must-not-fetch");
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);

    const pending = manager.download({
        ownerId: "user-a",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    await persistenceStarted;
    runtimeGeneration = 2;
    releasePersistence();

    await assert.rejects(pending, /authentication session changed/i);
    assert.equal(fetches, 0);
    assert.deepEqual(await manager.list("user-a"), []);
});

test("a stale owner callback cannot adopt a replacement runtime with the same owner id", async () => {
    let runtimeGeneration = 1;
    const retiredController = new AbortController();
    const freshController = new AbortController();
    let currentLease = {
        generation: runtimeGeneration,
        signal: retiredController.signal,
    };
    let fetches = 0;
    const deps = createDependencies({
        getAuthRuntimeLease: () => currentLease,
        isAuthRuntimeCurrent: (generation) => generation === runtimeGeneration,
        fetch: async () => {
            fetches += 1;
            return new Response(Uint8Array.of(1), {
                status: 200,
                headers: { "content-length": "1" },
            });
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);
    const retiredLease = currentLease;
    manager.activateOwner("user-a", retiredLease);

    retiredController.abort();
    runtimeGeneration = 2;
    currentLease = {
        generation: runtimeGeneration,
        signal: freshController.signal,
    };

    await assert.rejects(
        async () =>
            manager.download({
                ownerId: "user-a",
                track: TRACK,
                sourceUrl: "/api/library/tracks/track-1/stream",
            }),
        /authentication session changed/i,
    );
    assert.equal(fetches, 0);

    manager.activateOwner("user-a", currentLease);
    assert.equal(
        (
            await manager.download({
                ownerId: "user-a",
                track: TRACK,
                sourceUrl: "/api/library/tracks/track-1/stream",
            })
        ).status,
        "ready",
    );
    assert.equal(fetches, 1);
});

test("revoking an owner lease aborts an in-flight credentialed fetch and removes its attempt", async () => {
    const authController = new AbortController();
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
        signalFetchStarted = resolve;
    });
    const deps = createDependencies({
        getAuthRuntimeLease: () => ({
            generation: 1,
            signal: authController.signal,
        }),
        isAuthRuntimeCurrent: () => !authController.signal.aborted,
        fetch: async (_input, init) => {
            signalFetchStarted();
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                    "abort",
                    () =>
                        reject(
                            new DOMException("Runtime retired", "AbortError"),
                        ),
                    { once: true },
                );
            });
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);
    const lease = deps.getAuthRuntimeLease();
    manager.activateOwner("user-a", lease);

    const pending = manager.download({
        ownerId: "user-a",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    await fetchStarted;
    authController.abort();

    await assert.rejects(pending, /runtime retired|session changed/i);
    assert.deepEqual(await manager.list("user-a"), []);
    assert.equal(deps.audioCache.responses.size, 0);
});

test("foreground download publishes ready metadata only after a complete atomic device-cache write", async () => {
    const deps = createDependencies();
    const manager = new DeviceOfflineDownloadManager(deps);

    const record = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    assert.equal(record.status, "ready");
    assert.equal(record.transferMode, "foreground");
    assert.equal(record.virtualUrl, "/__offline/audio/opaque-key-1");
    assert.equal(record.sourceUrl.includes("token="), false);
    assert.equal(record.bytesReceived, 6);
    assert.equal(record.totalBytes, 6);
    assert.equal(record.persistenceGranted, true);
    assert.equal(deps.audioCache.putCalls, 1);
    const cached = await deps.audioCache.match(
        "https://soundspan.test/__offline/audio/opaque-key-1",
    );
    assert.ok(cached);
    assert.deepEqual(
        new Uint8Array(await cached.arrayBuffer()),
        Uint8Array.from([0, 1, 2, 3, 4, 5]),
    );
});

test("configured device-file storage retains new audio outside CacheStorage", async () => {
    const audioVault = new MemoryDeviceAudioVault();
    const deps = createDependencies({ audioVault });
    const manager = new DeviceOfflineDownloadManager(deps);

    const record = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    assert.equal(record.status, "ready");
    assert.match(String(record.mediaRef), /^test-vault:user-1:/);
    assert.equal(record.bytesReceived, 6);
    assert.equal(record.totalBytes, 6);
    assert.equal(audioVault.retainCalls, 1);
    assert.equal(audioVault.files.size, 1);
    assert.equal(deps.audioCache.putCalls, 0);
});

test("browser-private storage publishes a declined durable-persistence result", async () => {
    const audioVault = new MemoryDeviceAudioVault(false, () => true, false);
    const deps = createDependencies({ audioVault });
    const manager = new DeviceOfflineDownloadManager(deps);

    const record = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    assert.equal(record.status, "ready");
    assert.equal(record.persistenceGranted, false);
});

test("real-file progress is throttled instead of writing metadata for every stream chunk", async () => {
    const chunkSize = 64 * 1024;
    const chunkCount = 8;
    const metadataStore = new ProgressCountingMetadataStore();
    const audioVault = new MemoryDeviceAudioVault();
    const deps = createDependencies({
        metadataStore,
        audioVault,
        fetch: async () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    for (let index = 0; index < chunkCount; index += 1) {
                        controller.enqueue(new Uint8Array(chunkSize));
                    }
                    controller.close();
                },
            });
            return new Response(stream, {
                status: 200,
                headers: {
                    "content-type": "audio/flac",
                    "content-length": String(chunkSize * chunkCount),
                },
            });
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);

    const ready = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    assert.equal(ready.status, "ready");
    assert.equal(ready.bytesReceived, chunkSize * chunkCount);
    assert.equal(metadataStore.progressWrites, 3);
    assert.equal(audioVault.retainCalls, 1);
});

test("device-file metadata becomes playable only after the atomic retain receipt", async () => {
    const audioVault = new MemoryDeviceAudioVault(true);
    const deps = createDependencies({ audioVault });
    const manager = new DeviceOfflineDownloadManager(deps);
    const pending = manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    await audioVault.retainStarted;
    const [progress] = await manager.list("user-1");
    assert.equal(progress.status, "downloading");
    assert.equal(progress.mediaRef, undefined);

    audioVault.resumeRetain();
    const ready = await pending;
    assert.equal(ready.status, "ready");
    assert.match(String(ready.mediaRef), /^test-vault:user-1:/);
});

test("auth rotation after a file write removes the stale file before rejecting ready metadata", async () => {
    let generation = 1;
    const authController = new AbortController();
    const audioVault = new MemoryDeviceAudioVault(true);
    const deps = createDependencies({
        audioVault,
        getAuthRuntimeLease: () => ({
            generation,
            signal: authController.signal,
        }),
        isAuthRuntimeCurrent: (candidate) => candidate === generation,
    });
    const manager = new DeviceOfflineDownloadManager(deps);
    const lease = deps.getAuthRuntimeLease();
    manager.activateOwner("user-1", lease);
    const pending = manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    await audioVault.retainStarted;
    authController.abort();
    generation = 2;
    audioVault.resumeRetain();

    await assert.rejects(pending, /authentication session changed/i);
    assert.equal(audioVault.files.size, 0);
    assert.equal(audioVault.removed.length, 1);
    assert.deepEqual(await manager.list("user-1"), []);
    assert.equal(deps.audioCache.putCalls, 0);
});

test("delete and reconcile operate on an owner-scoped device-file reference", async () => {
    const audioVault = new MemoryDeviceAudioVault();
    const deps = createDependencies({ audioVault });
    const manager = new DeviceOfflineDownloadManager(deps);
    const first = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    const firstRef = first.mediaRef;
    assert.ok(firstRef);

    assert.equal(await manager.delete("user-1", first.key), true);
    assert.equal(audioVault.files.has(firstRef), false);
    assert.equal(deps.audioCache.putCalls, 0);

    const second = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    assert.ok(second.mediaRef);
    audioVault.files.delete(second.mediaRef);

    const [reconciled] = await manager.reconcile("user-1");
    assert.equal(reconciled.status, "interrupted");
    assert.equal(reconciled.errorCode, "device_file_missing");
});

test("legacy CacheStorage copies migrate atomically into the selected device folder", async () => {
    const deps = createDependencies();
    const manager = new DeviceOfflineDownloadManager(deps);
    const legacy = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    const legacyUrl = `https://soundspan.test${legacy.virtualUrl}`;
    assert.ok(await deps.audioCache.match(legacyUrl));
    assert.equal(legacy.mediaRef, undefined);

    const audioVault = new MemoryDeviceAudioVault();
    deps.audioVault = audioVault;
    assert.equal(await manager.migrateLegacyCache("user-1"), 1);

    const [migrated] = await manager.list("user-1");
    assert.equal(migrated.status, "ready");
    assert.match(String(migrated.mediaRef), /^test-vault:user-1:/);
    assert.equal(audioVault.files.size, 1);
    assert.equal(await deps.audioCache.match(legacyUrl), null);
});

test("legacy cache cleanup retries after delete failure without retaining a second file", async () => {
    class RetryableDeleteAudioCache extends MemoryAudioCache {
        deleteCalls = 0;
        failNextDelete = true;

        override async delete(url: string): Promise<void> {
            this.deleteCalls += 1;
            if (this.failNextDelete) {
                this.failNextDelete = false;
                throw new Error("legacy cache cleanup failed");
            }
            await super.delete(url);
        }
    }

    const audioCache = new RetryableDeleteAudioCache();
    const deps = createDependencies({ audioCache });
    const manager = new DeviceOfflineDownloadManager(deps);
    const legacy = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    const legacyUrl = `https://soundspan.test${legacy.virtualUrl}`;
    assert.ok(await audioCache.match(legacyUrl));

    const audioVault = new MemoryDeviceAudioVault();
    deps.audioVault = audioVault;
    await assert.rejects(
        manager.migrateLegacyCache("user-1"),
        /legacy cache cleanup failed/,
    );

    const [migrated] = await manager.list("user-1");
    assert.ok(migrated.mediaRef);
    assert.equal(audioVault.retainCalls, 1);
    assert.ok(await audioCache.match(legacyUrl));

    assert.equal(await manager.migrateLegacyCache("user-1"), 0);
    assert.equal(audioVault.retainCalls, 1);
    assert.equal(audioCache.deleteCalls, 2);
    assert.equal(await audioCache.match(legacyUrl), null);
});

test("legacy migration retries a transient cache inspection failure", async () => {
    class RetryableMatchAudioCache extends MemoryAudioCache {
        failNextMatch = false;

        override async match(url: string): Promise<Response | null> {
            if (this.failNextMatch) {
                this.failNextMatch = false;
                throw new Error("legacy cache inspection failed");
            }
            return super.match(url);
        }
    }

    const audioCache = new RetryableMatchAudioCache();
    const deps = createDependencies({ audioCache });
    const manager = new DeviceOfflineDownloadManager(deps);
    await manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    const audioVault = new MemoryDeviceAudioVault();
    deps.audioVault = audioVault;
    audioCache.failNextMatch = true;
    await assert.rejects(
        manager.migrateLegacyCache("user-1"),
        /legacy cache inspection failed/,
    );
    assert.equal(audioVault.retainCalls, 0);
    assert.equal((await manager.list("user-1"))[0]?.mediaRef, undefined);

    assert.equal(await manager.migrateLegacyCache("user-1"), 1);
    assert.equal(audioVault.retainCalls, 1);
    assert.ok((await manager.list("user-1"))[0]?.mediaRef);
});

test("concurrent legacy migrations publish one file and discard the losing receipt", async () => {
    const shared = createDependencies();
    const legacyManager = new DeviceOfflineDownloadManager(shared);
    await legacyManager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    const firstVault = new MemoryDeviceAudioVault(true);
    const secondVault = new MemoryDeviceAudioVault(true);
    const firstManager = new DeviceOfflineDownloadManager(
        createDependencies({
            metadataStore: shared.metadataStore,
            audioCache: shared.audioCache,
            audioVault: firstVault,
        }),
    );
    const secondManager = new DeviceOfflineDownloadManager(
        createDependencies({
            metadataStore: shared.metadataStore,
            audioCache: shared.audioCache,
            audioVault: secondVault,
        }),
    );

    const firstMigration = firstManager.migrateLegacyCache("user-1");
    const secondMigration = secondManager.migrateLegacyCache("user-1");
    await Promise.all([firstVault.retainStarted, secondVault.retainStarted]);
    firstVault.resumeRetain();
    const firstCount = await firstMigration;
    secondVault.resumeRetain();
    const secondCount = await secondMigration;

    assert.equal(firstCount + secondCount, 1);
    assert.equal(firstVault.files.size + secondVault.files.size, 1);
    const [migrated] = await firstManager.list("user-1");
    assert.ok(migrated.mediaRef);
    assert.equal(
        firstVault.files.has(migrated.mediaRef) ||
            secondVault.files.has(migrated.mediaRef),
        true,
    );
});

test("failed real-file deletion keeps recoverable metadata until a retry succeeds", async () => {
    const audioVault = new MemoryDeviceAudioVault();
    const deps = createDependencies({ audioVault });
    const manager = new DeviceOfflineDownloadManager(deps);
    const ready = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    assert.ok(ready.mediaRef);

    audioVault.failRemove = true;
    await assert.rejects(
        manager.delete("user-1", ready.key),
        /Device file removal failed/,
    );
    const [recoverable] = await manager.list("user-1");
    assert.equal(recoverable.key, ready.key);
    assert.equal(recoverable.mediaRef, ready.mediaRef);
    assert.equal(recoverable.status, "error");
    assert.equal(recoverable.errorCode, "device_file_delete_failed");
    assert.equal(audioVault.files.size, 1);

    audioVault.failRemove = false;
    assert.equal(await manager.delete("user-1", ready.key), true);
    assert.deepEqual(await manager.list("user-1"), []);
    assert.equal(audioVault.files.size, 0);
});

test("manual promotion cannot convert a device-file deletion tombstone", async () => {
    const audioVault = new MemoryDeviceAudioVault();
    const deps = createDependencies({ audioVault });
    const manager = new DeviceOfflineDownloadManager(deps);
    const ready = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
        management: "auto-liked",
    });

    audioVault.failRemove = true;
    await assert.rejects(
        manager.delete("user-1", ready.key),
        /Device file removal failed/,
    );
    const [tombstone] = await manager.list("user-1");
    assert.equal(tombstone.status, "error");
    assert.equal(tombstone.management, "auto-liked");

    const unchanged = await manager.promoteToManual("user-1", ready.key);

    assert.equal(unchanged?.status, "error");
    assert.equal(unchanged?.management, "auto-liked");
    assert.equal((await manager.list("user-1"))[0]?.management, "auto-liked");
});

test("auto-managed deletion cannot evict a copy promoted while its claim is pending", async () => {
    const metadataStore = new PausedAutoManagedClaimMetadataStore();
    const audioVault = new MemoryDeviceAudioVault();
    const deps = createDependencies({ metadataStore, audioVault });
    const deletingManager = new DeviceOfflineDownloadManager(deps);
    const promotingManager = new DeviceOfflineDownloadManager(deps);
    const ready = await deletingManager.download({
        ownerId: "user-1",
        track: TRACK,
        sourceUrl: "/api/library/tracks/track-1/stream",
        management: "auto-liked",
    });
    assert.ok(ready.mediaRef);

    const deletion = deletingManager.deleteAutoManagedIfCurrent(
        "user-1",
        ready,
    );
    await metadataStore.claimStarted;
    const promoted = await promotingManager.promoteToManual(
        "user-1",
        ready.key,
    );
    metadataStore.resumeClaim();

    assert.equal(promoted?.management, "manual");
    assert.equal(await deletion, false);
    assert.equal(
        (await deletingManager.list("user-1"))[0]?.management,
        "manual",
    );
    assert.equal(audioVault.files.has(ready.mediaRef), true);
});

test("foreground download publishes measured progress before cache integrity verification", async () => {
    const audioCache = new PausedAudioCache();
    const deps = createDependencies({ audioCache });
    const manager = new DeviceOfflineDownloadManager(deps);
    const pending = manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    await audioCache.putStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const progress = [...deps.metadataStore.records.values()][0];
    assert.equal(progress.status, "downloading");
    assert.equal(progress.bytesReceived, 6);
    assert.equal(progress.totalBytes, 6);
    assert.equal(progress.integrityVersion, undefined);

    audioCache.resumePut();
    const ready = await pending;
    assert.equal(ready.status, "ready");
    assert.equal(ready.integrityVersion, 1);
});

test("foreground progress metadata is throttled instead of writing every stream chunk", async () => {
    class CountingProgressMetadataStore extends MemoryMetadataStore {
        progressWrites = 0;

        override async putIfCurrent(
            expected: DeviceOfflineDownloadRecord,
            next: DeviceOfflineDownloadRecord,
        ): Promise<boolean> {
            if (
                next.status === "downloading" &&
                next.bytesReceived > expected.bytesReceived
            ) {
                this.progressWrites += 1;
            }
            return super.putIfCurrent(expected, next);
        }
    }
    const metadataStore = new CountingProgressMetadataStore();
    const deps = createDependencies({
        metadataStore,
        fetch: async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        for (let index = 0; index < 20; index += 1) {
                            controller.enqueue(Uint8Array.of(index));
                        }
                        controller.close();
                    },
                }),
                { status: 200, headers: { "content-length": "20" } },
            ),
    });
    const manager = new DeviceOfflineDownloadManager(deps);

    await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    assert.ok(metadataStore.progressWrites >= 1);
    assert.ok(metadataStore.progressWrites <= 2);
});

test("lease and progress writes cannot regress one another in IndexedDB", () => {
    const current: DeviceOfflineDownloadRecord = {
        key: "progress-key",
        ownerId: "user-1",
        trackIdentity: "track:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/progress-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "downloading",
        transferMode: "foreground",
        backgroundFetchId: null,
        foregroundLeaseId: "lease-1",
        foregroundLeaseExpiresAt: 90_000,
        bytesReceived: 512_000,
        totalBytes: 1_024_000,
        contentType: "audio/mpeg",
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: 30_000,
        errorCode: null,
        errorMessage: null,
    };
    const staleHeartbeat = {
        ...current,
        bytesReceived: 0,
        foregroundLeaseExpiresAt: 80_000,
        updatedAt: 20_000,
    };

    const merged = mergeConcurrentDeviceOfflineUpdate(current, staleHeartbeat);
    assert.equal(merged.bytesReceived, 512_000);
    assert.equal(merged.totalBytes, 1_024_000);
    assert.equal(merged.foregroundLeaseExpiresAt, 90_000);
    assert.equal(merged.updatedAt, 30_000);
});

test("foreground download rejects a retained cache body shorter than Content-Length", async () => {
    class TruncatingAudioCache extends MemoryAudioCache {
        override async put(url: string, response: Response): Promise<void> {
            this.putCalls += 1;
            const bytes = new Uint8Array(await response.arrayBuffer());
            this.responses.set(
                url,
                new Response(bytes.slice(0, Math.max(0, bytes.length - 1)), {
                    status: 200,
                    headers: response.headers,
                }),
            );
        }
    }

    const audioCache = new TruncatingAudioCache();
    const deps = createDependencies({ audioCache });
    const manager = new DeviceOfflineDownloadManager(deps);

    await assert.rejects(
        manager.download({
            ownerId: "user-1",
            track: TRACK,
            quality: "auto",
            sourceUrl: "/api/library/tracks/track-1/stream",
        }),
        /complete|length|bytes/i,
    );

    const failed = [...deps.metadataStore.records.values()][0];
    assert.equal(failed.status, "error");
    assert.equal(failed.errorCode, "cache");
    assert.equal(deps.audioCache.responses.size, 0);
});

test("a progress failure drains the cache write before deleting its partial entry", async () => {
    const audioCache = new DelayedFailingAudioCache();
    const deps = createDependencies({
        audioCache,
        fetch: async () =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.error(new Error("progress stream failed"));
                    },
                }),
                { status: 200 },
            ),
    });
    const manager = new DeviceOfflineDownloadManager(deps);
    const rejectedDownload = assert.rejects(
        manager.download({
            ownerId: "user-1",
            track: TRACK,
            quality: "auto",
            sourceUrl: "/api/library/tracks/track-1/stream",
        }),
        /progress stream failed/,
    );

    await audioCache.putStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
        assert.equal(audioCache.deleteCalls, 0);
    } finally {
        audioCache.failPut();
    }

    await rejectedDownload;
    assert.equal(audioCache.deleteBeforePutSettled, false);
    assert.equal(audioCache.deleteCalls, 1);
});

test("a foreground transfer without Content-Length records measured bytes without a bogus zero header", async () => {
    const deps = createDependencies({
        fetch: async () =>
            new Response(Uint8Array.from([5, 4, 3, 2]), {
                status: 200,
                headers: { "content-type": "audio/mpeg" },
            }),
    });
    const manager = new DeviceOfflineDownloadManager(deps);

    const record = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    const cached = await deps.audioCache.match(
        `https://soundspan.test${record.virtualUrl}`,
    );

    assert.equal(record.bytesReceived, 4);
    assert.equal(record.totalBytes, 4);
    assert.equal(cached?.headers.get("content-length"), null);
});

test("interrupted foreground download resumes into a fresh opaque attempt", async () => {
    let attempts = 0;
    const deps = createDependencies({
        fetch: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new TypeError("network disconnected");
            }
            return new Response(Uint8Array.from([7, 8, 9]), {
                status: 200,
                headers: { "content-length": "3" },
            });
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);

    await assert.rejects(
        manager.download({
            ownerId: "user-1",
            track: TRACK,
            quality: "auto",
            sourceUrl: "/api/library/tracks/track-1/stream",
        }),
        /network disconnected/,
    );
    const interrupted = [...deps.metadataStore.records.values()][0];
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.attempt, 1);
    assert.equal(deps.audioCache.responses.size, 0);

    const resumed = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    assert.equal(resumed.status, "ready");
    assert.notEqual(resumed.key, interrupted.key);
    assert.equal(resumed.virtualUrl, "/__offline/audio/opaque-key-2");
    assert.equal(resumed.attempt, 2);
});

test("quota preflight fails without leaving partial audio in CacheStorage", async () => {
    const deps = createDependencies({
        estimateStorage: async () => ({ usage: 90, quota: 94 }),
    });
    const manager = new DeviceOfflineDownloadManager(deps);

    await assert.rejects(
        manager.download({
            ownerId: "user-1",
            track: TRACK,
            quality: "auto",
            sourceUrl: "/api/library/tracks/track-1/stream",
        }),
        /storage/i,
    );

    const failed = [...deps.metadataStore.records.values()][0];
    assert.equal(failed.status, "error");
    assert.equal(failed.errorCode, "quota");
    assert.equal(deps.audioCache.responses.size, 0);
});

test("unverified playback records stay isolated and cannot shadow the network URL", async () => {
    const deps = createDependencies();
    const manager = new DeviceOfflineDownloadManager(deps);
    const first = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    const high = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "high",
        sourceUrl: "/api/library/tracks/track-1/stream?quality=high",
    });
    const otherOwner = await manager.download({
        ownerId: "user-2",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    assert.notEqual(first.key, high.key);
    assert.notEqual(first.key, otherOwner.key);
    setDeviceOfflineRuntimeState("user-1", [first, high]);
    assert.equal(
        resolveDeviceOfflinePlaybackUrl(
            TRACK,
            "https://soundspan.test/api/library/tracks/track-1/stream",
            "high",
        ),
        "https://soundspan.test/api/library/tracks/track-1/stream",
    );

    setDeviceOfflineRuntimeState("user-2", [otherOwner]);
    assert.equal(
        resolveDeviceOfflinePlaybackUrl(
            TRACK,
            "https://soundspan.test/api/library/tracks/track-1/stream",
            "high",
        ),
        "https://soundspan.test/api/library/tracks/track-1/stream",
    );

    clearDeviceOfflineRuntimeState();
    assert.equal(
        resolveDeviceOfflinePlaybackUrl(
            TRACK,
            "https://soundspan.test/api/library/tracks/track-1/stream",
            "auto",
        ),
        "https://soundspan.test/api/library/tracks/track-1/stream",
    );
});

test("another account in the same browser cannot delete or inherit a device-local copy", async () => {
    const deps = createDependencies();
    const manager = new DeviceOfflineDownloadManager(deps);
    const ownerCopy = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    const absoluteVirtualUrl = `https://soundspan.test${ownerCopy.virtualUrl}`;

    assert.deepEqual(await manager.list("user-2"), []);
    assert.equal(await manager.delete("user-2", ownerCopy.key), false);
    assert.equal((await manager.list("user-1"))[0]?.status, "ready");
    assert.ok(await deps.audioCache.match(absoluteVirtualUrl));
});

test("keeping an auto-liked device file promotes it without downloading or replacing it", async () => {
    let fetchCalls = 0;
    const audioVault = new MemoryDeviceAudioVault();
    const deps = createDependencies({
        audioVault,
        fetch: async () => {
            fetchCalls += 1;
            return new Response(Uint8Array.from([0, 1, 2, 3, 4, 5]), {
                status: 200,
                headers: {
                    "content-type": "audio/mpeg",
                    "content-length": "6",
                },
            });
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);
    const automatic = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
        management: "auto-liked",
    });
    assert.ok(automatic.mediaRef);

    const kept = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
        management: "manual",
    });

    assert.equal(kept.key, automatic.key);
    assert.equal(kept.mediaRef, automatic.mediaRef);
    assert.equal(kept.status, "ready");
    assert.equal(kept.management, "manual");
    assert.equal(fetchCalls, 1);
    assert.equal(audioVault.retainCalls, 1);
    assert.equal(audioVault.removed.length, 0);
    assert.equal(audioVault.files.size, 1);
});

test("resuming a durable manual download keeps an already ready device file", async () => {
    let fetchCalls = 0;
    const audioVault = new MemoryDeviceAudioVault();
    const deps = createDependencies({
        audioVault,
        fetch: async () => {
            fetchCalls += 1;
            return new Response(Uint8Array.from([0, 1, 2, 3, 4, 5]), {
                status: 200,
                headers: {
                    "content-type": "audio/mpeg",
                    "content-length": "6",
                },
            });
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);
    const ready = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    const resumed = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    assert.equal(resumed.key, ready.key);
    assert.equal(resumed.mediaRef, ready.mediaRef);
    assert.equal(resumed.management, "manual");
    assert.equal(fetchCalls, 1);
    assert.equal(audioVault.retainCalls, 1);
    assert.equal(audioVault.removed.length, 0);
});

test("resuming an auto-liked download keeps an already ready managed file", async () => {
    let fetchCalls = 0;
    const audioVault = new MemoryDeviceAudioVault();
    const deps = createDependencies({
        audioVault,
        fetch: async () => {
            fetchCalls += 1;
            return new Response(Uint8Array.from([0, 1, 2, 3, 4, 5]), {
                status: 200,
                headers: {
                    "content-type": "audio/mpeg",
                    "content-length": "6",
                },
            });
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);
    const ready = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
        management: "auto-liked",
    });

    const resumed = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
        management: "auto-liked",
    });

    assert.equal(resumed.key, ready.key);
    assert.equal(resumed.mediaRef, ready.mediaRef);
    assert.equal(resumed.management, "auto-liked");
    assert.equal(fetchCalls, 1);
    assert.equal(audioVault.retainCalls, 1);
    assert.equal(audioVault.removed.length, 0);
});

test("manual device copies are never downgraded to auto-managed eviction candidates", async () => {
    const deps = createDependencies();
    const manager = new DeviceOfflineDownloadManager(deps);
    const manual = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    assert.equal(manual.management, "manual");

    const retriedByAutomation = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
        management: "auto-liked",
    });
    assert.equal(retriedByAutomation.management, "manual");

    const automatic = await manager.download({
        ownerId: "user-1",
        track: {
            ...TRACK,
            id: "yt:auto-track",
            youtubeVideoId: "auto-track",
            streamSource: "youtube",
        },
        quality: "auto",
        sourceUrl: "/api/ytmusic/stream-public/auto-track",
        management: "auto-liked",
    });
    assert.equal(automatic.management, "auto-liked");
    assert.equal(await manager.promoteToManual("user-2", automatic.key), null);
    assert.equal(
        (await manager.promoteToManual("user-1", automatic.key))?.management,
        "manual",
    );
});

test("reconcile cannot downgrade a ready copy promoted to manual during cache verification", async () => {
    class DeferredMatchAudioCache extends MemoryAudioCache {
        readonly matchStarted: Promise<void>;
        private signalMatchStarted!: () => void;
        private releaseMatch!: () => void;
        private readonly matchRelease: Promise<void>;
        pauseMatch = false;

        constructor() {
            super();
            this.matchStarted = new Promise((resolve) => {
                this.signalMatchStarted = resolve;
            });
            this.matchRelease = new Promise((resolve) => {
                this.releaseMatch = resolve;
            });
        }

        override async match(url: string): Promise<Response | null> {
            const response = await super.match(url);
            if (!this.pauseMatch) return response;
            this.signalMatchStarted();
            await this.matchRelease;
            return response;
        }

        resumeMatch(): void {
            this.releaseMatch();
        }
    }

    let now = 100;
    const audioCache = new DeferredMatchAudioCache();
    const deps = createDependencies({ audioCache, now: () => now });
    const manager = new DeviceOfflineDownloadManager(deps);
    const ready = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
        management: "auto-liked",
    });
    await deps.metadataStore.put({
        ...ready,
        integrityVersion: undefined,
    });
    audioCache.pauseMatch = true;

    const reconciliation = manager.reconcile("user-1");
    await audioCache.matchStarted;
    now = 200;
    const promoted = await manager.promoteToManual("user-1", ready.key);
    assert.equal(promoted?.management, "manual");
    assert.equal(promoted?.updatedAt, 200);
    audioCache.resumeMatch();

    const [reconciled] = await reconciliation;
    assert.equal(reconciled.management, "manual");
    assert.equal(reconciled.updatedAt, 200);
    assert.equal(reconciled.integrityVersion, 1);
});

test("background mode is accepted only when the platform adapter actually starts it", async () => {
    let foregroundFetches = 0;
    const deps = createDependencies({
        fetch: async () => {
            foregroundFetches += 1;
            return new Response("foreground");
        },
        startBackgroundFetch: async (candidate) => {
            const published = await deps.metadataStore.getByKey(candidate.key);
            assert.equal(published?.status, "downloading");
            assert.equal(published?.transferMode, "background");
            assert.equal(
                published?.backgroundFetchId,
                candidate.backgroundFetchId,
            );
            return "started";
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);

    const record = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    assert.equal(record.status, "downloading");
    assert.equal(record.transferMode, "background");
    assert.match(record.backgroundFetchId ?? "", /::1$/);
    assert.equal(foregroundFetches, 0);
});

test("an ambiguous Background Fetch start keeps a bounded verification lease without foreground duplication", async () => {
    let currentTime = 300_000;
    let foregroundFetches = 0;
    let expiryCheck: (() => void) | null = null;
    let expiryDelay = 0;
    const deps = createDependencies({
        now: () => currentTime,
        fetch: async () => {
            foregroundFetches += 1;
            return new Response("must-not-download");
        },
        startBackgroundFetch: async () => "unknown",
        listActiveBackgroundFetches: async () => [],
        scheduleLeaseExpiryCheck: (callback, delayMs) => {
            expiryCheck = callback;
            expiryDelay = delayMs;
            return Symbol("ambiguous-background-verification");
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);

    const candidate = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });

    assert.equal(candidate.transferMode, "background");
    assert.equal(candidate.status, "downloading");
    assert.ok(candidate.foregroundLeaseId);
    assert.equal(foregroundFetches, 0);
    assert.ok(expiryCheck);
    assert.ok(expiryDelay > 0);

    currentTime = (candidate.foregroundLeaseExpiresAt ?? currentTime) + 1;
    (expiryCheck as unknown as () => void)();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const interrupted = (await manager.list("user-1"))[0];
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.backgroundFetchId, null);
    assert.equal(foregroundFetches, 0);
});

test("verification expiry rechecks and confirms a late ambiguous Background Fetch registration", async () => {
    let currentTime = 400_000;
    let activeIds: string[] = [];
    let expiryCheck: (() => void) | null = null;
    const deps = createDependencies({
        now: () => currentTime,
        startBackgroundFetch: async () => "unknown",
        listActiveBackgroundFetches: async () => activeIds,
        scheduleLeaseExpiryCheck: (callback) => {
            expiryCheck = callback;
            return Symbol("late-background-check");
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);
    const candidate = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    assert.equal((await manager.reconcile("user-1"))[0]?.status, "downloading");
    activeIds = [candidate.backgroundFetchId ?? ""];
    currentTime = (candidate.foregroundLeaseExpiresAt ?? currentTime) + 1;
    assert.ok(expiryCheck);
    (expiryCheck as unknown as () => void)();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const confirmed = (await manager.list("user-1"))[0];

    assert.equal(confirmed.status, "downloading");
    assert.equal(confirmed.transferMode, "background");
    assert.match(confirmed.foregroundLeaseId ?? "", /^background-stall:/);
    assert.equal(
        confirmed.foregroundLeaseExpiresAt,
        candidate.updatedAt + DEVICE_OFFLINE_BACKGROUND_STALL_MS,
    );
});

test("unknown registration enumeration extends an expired background verification lease by a bounded retry", async () => {
    let currentTime = 500_000;
    const expiryChecks: Array<() => void> = [];
    const deps = createDependencies({
        now: () => currentTime,
        startBackgroundFetch: async () => "unknown",
        listActiveBackgroundFetches: async () => {
            throw new Error("browser registration temporarily unavailable");
        },
        scheduleLeaseExpiryCheck: (callback) => {
            expiryChecks.push(callback);
            return Symbol(`background-retry-${expiryChecks.length}`);
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);
    const candidate = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    currentTime = (candidate.foregroundLeaseExpiresAt ?? currentTime) + 1;

    expiryChecks[0]?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const extended = (await manager.list("user-1"))[0];
    assert.equal(extended.status, "downloading");
    assert.equal(extended.transferMode, "background");
    assert.equal(
        extended.foregroundLeaseExpiresAt,
        currentTime + DEVICE_OFFLINE_BACKGROUND_MISSING_GRACE_MS,
    );
    assert.match(extended.foregroundLeaseId ?? "", /^background-unknown:1:/);
    assert.equal(expiryChecks.length, 2);

    for (
        let retry = 1;
        retry <= DEVICE_OFFLINE_BACKGROUND_UNKNOWN_RETRY_LIMIT;
        retry += 1
    ) {
        const current = (await manager.list("user-1"))[0];
        currentTime = (current.foregroundLeaseExpiresAt ?? currentTime) + 1;
        expiryChecks[retry]?.();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    assert.equal((await manager.list("user-1"))[0]?.status, "interrupted");
});

test("reconcile preserves a background registration while another manager is still starting it", async () => {
    const metadataStore = new MemoryMetadataStore();
    let signalRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
        signalRegistrationStarted = resolve;
    });
    let finishRegistration!: (started: "started") => void;
    const registrationResult = new Promise<"started">((resolve) => {
        finishRegistration = resolve;
    });
    const aborted: string[] = [];
    const deps = createDependencies({
        metadataStore,
        startBackgroundFetch: async () => {
            signalRegistrationStarted();
            return registrationResult;
        },
        abortBackgroundFetch: async (record) => {
            aborted.push(record.backgroundFetchId ?? "");
            return "cleared";
        },
        listActiveBackgroundFetches: async () => [],
    });
    const managerA = new DeviceOfflineDownloadManager(deps);
    const managerB = new DeviceOfflineDownloadManager(deps);

    const pending = managerA.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    await registrationStarted;
    const starting = [...metadataStore.records.values()][0];
    assert.equal(starting.transferMode, "background");
    assert.ok(starting.foregroundLeaseId);

    assert.equal(
        (await managerB.reconcile("user-1"))[0]?.status,
        "downloading",
    );
    finishRegistration("started");
    const started = await pending;

    assert.equal(started.status, "downloading");
    assert.equal(started.transferMode, "background");
    assert.equal(started.foregroundLeaseId, null);
    assert.equal(started.foregroundLeaseExpiresAt, null);
    assert.deepEqual(aborted, []);
});

test("reconcile preserves a live foreground transfer owned by another manager", async () => {
    const metadataStore = new MemoryMetadataStore();
    const audioCache = new MemoryAudioCache();
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
        signalFetchStarted = resolve;
    });
    let releaseFetch!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
        releaseFetch = resolve;
    });
    const deps = createDependencies({
        metadataStore,
        audioCache,
        fetch: async () => {
            signalFetchStarted();
            return pendingResponse;
        },
    });
    const managerA = new DeviceOfflineDownloadManager(deps);
    const managerB = new DeviceOfflineDownloadManager(deps);

    const pending = managerA.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    await fetchStarted;
    const reconciled = await managerB.reconcile("user-1");
    releaseFetch(
        new Response(Uint8Array.from([6, 7, 8]), {
            status: 200,
            headers: { "content-length": "3" },
        }),
    );
    const completion = await pending.then(
        (record) => ({ status: "fulfilled" as const, record }),
        (error: unknown) => ({ status: "rejected" as const, error }),
    );

    assert.equal(reconciled[0]?.status, "downloading");
    assert.equal(completion.status, "fulfilled");
    if (completion.status === "fulfilled") {
        assert.equal(completion.record.status, "ready");
        assert.ok(
            await audioCache.match(
                `https://soundspan.test${completion.record.virtualUrl}`,
            ),
        );
    }
});

test("a foreground heartbeat keeps a long transfer live until completion", async () => {
    const metadataStore = new MemoryMetadataStore();
    let currentTime = 10_000;
    let heartbeat: (() => void) | null = null;
    let heartbeatCancelled = false;
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
        signalFetchStarted = resolve;
    });
    let releaseFetch!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
        releaseFetch = resolve;
    });
    const deps = createDependencies({
        metadataStore,
        now: () => currentTime,
        fetch: async () => {
            signalFetchStarted();
            return pendingResponse;
        },
        scheduleLeaseHeartbeat: (callback) => {
            heartbeat = callback;
            return Symbol("controlled-heartbeat");
        },
        cancelLeaseHeartbeat: () => {
            heartbeatCancelled = true;
        },
    });
    const managerA = new DeviceOfflineDownloadManager(deps);
    const managerB = new DeviceOfflineDownloadManager(deps);

    const pending = managerA.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    await fetchStarted;
    const initial = [...metadataStore.records.values()][0];
    const initialExpiry = initial.foregroundLeaseExpiresAt!;
    currentTime = initialExpiry - 1;
    assert.ok(heartbeat);
    (heartbeat as unknown as () => void)();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const renewed = [...metadataStore.records.values()][0];
    assert.equal(
        renewed.foregroundLeaseExpiresAt,
        currentTime + DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
    );

    currentTime = initialExpiry + 1;
    assert.equal(
        (await managerB.reconcile("user-1"))[0]?.status,
        "downloading",
    );
    releaseFetch(
        new Response(Uint8Array.from([3, 2, 1]), {
            status: 200,
            headers: { "content-length": "3" },
        }),
    );
    assert.equal((await pending).status, "ready");
    assert.equal(heartbeatCancelled, true);
});

test("reconcile interrupts an expired foreground lease but gives legacy records a bounded grace period", async () => {
    const metadataStore = new MemoryMetadataStore();
    let currentTime = 100_000;
    const active: DeviceOfflineDownloadRecord = {
        key: "expired-foreground-key",
        ownerId: "user-1",
        trackIdentity: "track:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/expired-foreground-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "downloading",
        transferMode: "foreground",
        backgroundFetchId: null,
        foregroundLeaseId: "expired-lease",
        foregroundLeaseExpiresAt: currentTime - 1,
        bytesReceived: 0,
        totalBytes: null,
        contentType: null,
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: currentTime - 1,
        errorCode: null,
        errorMessage: null,
    };
    await metadataStore.put(active);
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({ metadataStore, now: () => currentTime }),
    );

    const expired = (await manager.reconcile("user-1"))[0];
    assert.equal(expired.status, "interrupted");
    assert.equal(expired.foregroundLeaseId, null);
    assert.equal(expired.foregroundLeaseExpiresAt, null);

    const legacy = {
        ...active,
        key: "legacy-foreground-key",
        virtualUrl: "/__offline/audio/legacy-foreground-key",
        foregroundLeaseId: undefined,
        foregroundLeaseExpiresAt: undefined,
        updatedAt: currentTime,
    };
    metadataStore.records.clear();
    await metadataStore.put(legacy);
    assert.equal((await manager.reconcile("user-1"))[0]?.status, "downloading");

    currentTime += DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS + 1;
    assert.equal((await manager.reconcile("user-1"))[0]?.status, "interrupted");
});

test("reconcile clamps a wildly future foreground lease before it can become immortal", async () => {
    const metadataStore = new MemoryMetadataStore();
    let currentTime = 500_000;
    const record: DeviceOfflineDownloadRecord = {
        key: "clock-skew-key",
        ownerId: "user-1",
        trackIdentity: "track:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/clock-skew-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "downloading",
        transferMode: "foreground",
        backgroundFetchId: null,
        foregroundLeaseId: "clock-skew-lease",
        foregroundLeaseExpiresAt: currentTime + 3_600_000,
        bytesReceived: 0,
        totalBytes: null,
        contentType: null,
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: currentTime + 3_600_000,
        errorCode: null,
        errorMessage: null,
    };
    await metadataStore.put(record);
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({ metadataStore, now: () => currentTime }),
    );

    const clamped = (await manager.reconcile("user-1"))[0];
    assert.equal(clamped.status, "downloading");
    assert.equal(
        clamped.foregroundLeaseExpiresAt,
        currentTime + DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
    );
    currentTime += DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS + 1;
    assert.equal((await manager.reconcile("user-1"))[0]?.status, "interrupted");
});

test("a failed background registration enumeration is unknown, not proof of interruption", async () => {
    const metadataStore = new MemoryMetadataStore();
    const currentTime = 700_000;
    const record: DeviceOfflineDownloadRecord = {
        key: "background-enumeration-key",
        ownerId: "user-1",
        trackIdentity: "track:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/background-enumeration-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "downloading",
        transferMode: "background",
        backgroundFetchId:
            "soundspan-device-audio-background-enumeration-key::1",
        bytesReceived: 0,
        totalBytes: null,
        contentType: null,
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: currentTime,
        errorCode: null,
        errorMessage: null,
    };
    await metadataStore.put(record);
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({
            metadataStore,
            now: () => currentTime,
            listActiveBackgroundFetches: async () => {
                throw new Error("registration temporarily unavailable");
            },
        }),
    );

    assert.deepEqual(await manager.reconcile("user-1"), [record]);
    assert.deepEqual(metadataStore.records.get(record.key), record);
});

test("a hung background registration enumeration cannot block offline hydration", async () => {
    const metadataStore = new MemoryMetadataStore();
    const currentTime = 800_000;
    const record: DeviceOfflineDownloadRecord = {
        key: "hung-background-enumeration-key",
        ownerId: "user-1",
        trackIdentity: "track:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/hung-background-enumeration-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "downloading",
        transferMode: "background",
        backgroundFetchId:
            "soundspan-device-audio-hung-background-enumeration-key::1",
        bytesReceived: 0,
        totalBytes: null,
        contentType: null,
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: currentTime,
        errorCode: null,
        errorMessage: null,
    };
    await metadataStore.put(record);
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({
            metadataStore,
            now: () => currentTime,
            backgroundFetchLookupTimeoutMs: 5,
            listActiveBackgroundFetches: () =>
                new Promise<never>(() => undefined),
        }),
    );

    assert.deepEqual(await manager.reconcile("user-1"), [record]);
    assert.deepEqual(metadataStore.records.get(record.key), record);
});

test("reconcile aborts a legacy Background Fetch stuck at zero and exposes a foreground retry", async () => {
    const metadataStore = new MemoryMetadataStore();
    const currentTime = 1_000_000;
    const backgroundFetchId =
        "soundspan-device-audio-stalled-background-key::1";
    const record: DeviceOfflineDownloadRecord = {
        key: "stalled-background-key",
        ownerId: "user-1",
        trackIdentity: "track:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/stalled-background-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "downloading",
        transferMode: "background",
        backgroundFetchId,
        foregroundLeaseId: null,
        foregroundLeaseExpiresAt: null,
        bytesReceived: 0,
        totalBytes: null,
        contentType: null,
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: currentTime - DEVICE_OFFLINE_BACKGROUND_STALL_MS,
        errorCode: null,
        errorMessage: null,
    };
    await metadataStore.put(record);
    const aborted: string[] = [];
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({
            metadataStore,
            now: () => currentTime,
            listActiveBackgroundFetches: async () => [backgroundFetchId],
            abortBackgroundFetch: async (candidate) => {
                aborted.push(candidate.backgroundFetchId ?? "");
                return "cleared";
            },
        }),
    );

    const [interrupted] = await manager.reconcile("user-1");

    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.backgroundFetchId, null);
    assert.equal(interrupted.errorCode, "background_stalled");
    assert.match(interrupted.errorMessage ?? "", /retry.*foreground/i);
    assert.deepEqual(aborted, [backgroundFetchId]);
});

test("reconcile clears a lingering Android Background Fetch after a verified copy is already ready", async () => {
    const metadataStore = new MemoryMetadataStore();
    const deps = createDependencies({ metadataStore });
    const initialManager = new DeviceOfflineDownloadManager(deps);
    const ready = await initialManager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    const backgroundFetchId = `soundspan-device-audio-${ready.key}::${ready.attempt}`;
    await metadataStore.put({
        ...ready,
        transferMode: "background",
        backgroundFetchId,
    });
    const aborted: string[] = [];
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({
            metadataStore,
            audioCache: deps.audioCache,
            listActiveBackgroundFetches: async () => [backgroundFetchId],
            abortBackgroundFetch: async (candidate) => {
                aborted.push(candidate.backgroundFetchId ?? "");
                return "cleared";
            },
        }),
    );

    const [reconciled] = await manager.reconcile("user-1");

    assert.equal(reconciled.status, "ready");
    assert.equal(reconciled.backgroundFetchId, null);
    assert.equal(reconciled.errorCode, null);
    assert.deepEqual(aborted, [backgroundFetchId]);
});

test("reconcile schedules an automatic timeout for a fresh legacy Background Fetch", async () => {
    const metadataStore = new MemoryMetadataStore();
    let currentTime = 2_000_000;
    const backgroundFetchId = "soundspan-device-audio-fresh-legacy-key::1";
    const record: DeviceOfflineDownloadRecord = {
        key: "fresh-legacy-key",
        ownerId: "user-1",
        trackIdentity: "track:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/fresh-legacy-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "downloading",
        transferMode: "background",
        backgroundFetchId,
        foregroundLeaseId: null,
        foregroundLeaseExpiresAt: null,
        bytesReceived: 0,
        totalBytes: null,
        contentType: null,
        persistenceGranted: true,
        attempt: 1,
        createdAt: currentTime,
        updatedAt: currentTime,
        errorCode: null,
        errorMessage: null,
    };
    await metadataStore.put(record);
    let expiryCheck: (() => void) | null = null;
    let expiryDelay = 0;
    const aborted: string[] = [];
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({
            metadataStore,
            now: () => currentTime,
            listActiveBackgroundFetches: async () => [backgroundFetchId],
            abortBackgroundFetch: async (candidate) => {
                aborted.push(candidate.backgroundFetchId ?? "");
                return "cleared";
            },
            scheduleLeaseExpiryCheck: (callback, delayMs) => {
                expiryCheck = callback;
                expiryDelay = delayMs;
                return Symbol("legacy-background-timeout");
            },
        }),
    );

    const [pending] = await manager.reconcile("user-1");

    assert.equal(pending.status, "downloading");
    assert.match(pending.foregroundLeaseId ?? "", /^background-stall:/);
    assert.equal(expiryDelay, DEVICE_OFFLINE_BACKGROUND_STALL_MS + 1);
    assert.ok(expiryCheck);

    currentTime += DEVICE_OFFLINE_BACKGROUND_STALL_MS + 1;
    (expiryCheck as unknown as () => void)();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const [interrupted] = await manager.list("user-1");
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.errorCode, "background_stalled");
    assert.deepEqual(aborted, [backgroundFetchId]);
});

test("reconcile removes a truncated ready cache entry instead of exposing it to playback", async () => {
    const deps = createDependencies();
    const manager = new DeviceOfflineDownloadManager(deps);
    const ready = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    await deps.metadataStore.put({ ...ready, integrityVersion: undefined });
    const absoluteVirtualUrl = `https://soundspan.test${ready.virtualUrl}`;
    deps.audioCache.responses.set(
        absoluteVirtualUrl,
        new Response(Uint8Array.from([0, 1, 2]), {
            headers: { "content-length": "6" },
        }),
    );

    const [interrupted] = await manager.reconcile("user-1");

    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.errorCode, "cache_integrity");
    assert.equal(await deps.audioCache.match(absoluteVirtualUrl), null);
});

test("reconcile keeps a damaged copy non-playable even when cache cleanup fails", async () => {
    class DeleteFailingAudioCache extends MemoryAudioCache {
        failDelete = false;

        override async delete(url: string): Promise<void> {
            if (this.failDelete) throw new Error("CacheStorage delete failed");
            await super.delete(url);
        }
    }

    const audioCache = new DeleteFailingAudioCache();
    const deps = createDependencies({ audioCache });
    const manager = new DeviceOfflineDownloadManager(deps);
    const ready = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    await deps.metadataStore.put({ ...ready, integrityVersion: undefined });
    const absoluteVirtualUrl = `https://soundspan.test${ready.virtualUrl}`;
    audioCache.responses.set(
        absoluteVirtualUrl,
        new Response(Uint8Array.from([0, 1, 2]), {
            headers: { "content-length": "6" },
        }),
    );
    audioCache.failDelete = true;

    const [interrupted] = await manager.reconcile("user-1");

    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.errorCode, "cache_integrity");
});

test("reconcile hides a ready copy when CacheStorage cannot be inspected", async () => {
    class MatchFailingAudioCache extends MemoryAudioCache {
        failMatch = false;

        override async match(url: string): Promise<Response | null> {
            if (this.failMatch) throw new Error("CacheStorage match failed");
            return super.match(url);
        }
    }

    const audioCache = new MatchFailingAudioCache();
    const deps = createDependencies({ audioCache });
    const manager = new DeviceOfflineDownloadManager(deps);
    await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    audioCache.failMatch = true;

    const [interrupted] = await manager.reconcile("user-1");

    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.errorCode, "cache_unavailable");
});

test("reconcile does not re-read every body after ready integrity was already verified", async () => {
    class BodyReadRejectingAudioCache extends MemoryAudioCache {
        rejectBodyReads = false;

        override async match(url: string): Promise<Response | null> {
            const response = await super.match(url);
            if (!response || !this.rejectBodyReads) return response;
            response.clone = () => {
                throw new Error("verified cache body was read again");
            };
            return response;
        }
    }

    const audioCache = new BodyReadRejectingAudioCache();
    const deps = createDependencies({ audioCache });
    const manager = new DeviceOfflineDownloadManager(deps);
    const ready = await manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    audioCache.rejectBodyReads = true;

    const [reconciled] = await manager.reconcile("user-1");

    assert.equal(ready.integrityVersion, 1);
    assert.equal(reconciled.status, "ready");
    assert.equal(reconciled.errorCode, null);
});

test("a missing background registration gets one bounded completion grace before interruption", async () => {
    const metadataStore = new MemoryMetadataStore();
    let currentTime = 200_000;
    const record: DeviceOfflineDownloadRecord = {
        key: "missing-background-key",
        ownerId: "user-1",
        trackIdentity: "track:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/missing-background-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "downloading",
        transferMode: "background",
        backgroundFetchId: "soundspan-device-audio-missing-background-key::1",
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
    await metadataStore.put(record);
    let expiryCheck: (() => void) | null = null;
    let expiryDelay = 0;
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({
            metadataStore,
            now: () => currentTime,
            listActiveBackgroundFetches: async () => [],
            scheduleLeaseExpiryCheck: (callback, delayMs) => {
                expiryCheck = callback;
                expiryDelay = delayMs;
                return Symbol("controlled-expiry-check");
            },
        }),
    );

    const grace = (await manager.reconcile("user-1"))[0];
    assert.equal(grace.status, "downloading");
    assert.match(grace.foregroundLeaseId ?? "", /^background-missing:/);
    assert.equal(
        grace.foregroundLeaseExpiresAt,
        currentTime + DEVICE_OFFLINE_BACKGROUND_MISSING_GRACE_MS,
    );
    assert.equal(expiryDelay, DEVICE_OFFLINE_BACKGROUND_MISSING_GRACE_MS + 1);

    currentTime += DEVICE_OFFLINE_BACKGROUND_MISSING_GRACE_MS + 1;
    assert.ok(expiryCheck);
    (expiryCheck as unknown as () => void)();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const interrupted = (await manager.list("user-1"))[0];
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.backgroundFetchId, null);
    assert.equal(interrupted.foregroundLeaseId, null);
});

test("a deleted background candidate is aborted instead of reported started", async () => {
    const metadataStore = new MemoryMetadataStore();
    const aborted: string[] = [];
    let foregroundFetches = 0;
    const deps = createDependencies({
        metadataStore,
        fetch: async () => {
            foregroundFetches += 1;
            return new Response("foreground");
        },
        startBackgroundFetch: async (candidate) => {
            assert.equal(await metadataStore.deleteIfCurrent(candidate), true);
            return "started";
        },
        abortBackgroundFetch: async (candidate) => {
            aborted.push(candidate.backgroundFetchId ?? "");
            return "cleared";
        },
    });
    const manager = new DeviceOfflineDownloadManager(deps);

    await assert.rejects(
        manager.download({
            ownerId: "user-1",
            track: TRACK,
            quality: "auto",
            sourceUrl: "/api/library/tracks/track-1/stream",
        }),
        /superseded|deleted/i,
    );

    assert.equal(foregroundFetches, 0);
    assert.deepEqual(aborted, ["soundspan-device-audio-opaque-key-1::1"]);
    assert.equal(metadataStore.records.size, 0);
});

test("two managers atomically claim one track-quality attempt and the loser cannot delete the winner cache", async () => {
    const metadataStore = new CoordinatedReadMetadataStore();
    const audioCache = new MemoryAudioCache();
    const previous: DeviceOfflineDownloadRecord = {
        key: "previous-key",
        ownerId: "user-1",
        trackIdentity: "track:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/previous-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "interrupted",
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 0,
        totalBytes: null,
        contentType: null,
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: "interrupted",
        errorMessage: "Interrupted",
    };
    await metadataStore.put(previous);
    let fetches = 0;
    let keySequence = 0;
    const deps = createDependencies({
        metadataStore,
        audioCache,
        createKey: () => `claim-key-${++keySequence}`,
        fetch: async () => {
            fetches += 1;
            return new Response(Uint8Array.from([1, 2, 3]), {
                status: 200,
                headers: { "content-length": "3" },
            });
        },
    });
    const managerA = new DeviceOfflineDownloadManager(deps);
    const managerB = new DeviceOfflineDownloadManager(deps);

    const results = await Promise.allSettled([
        managerA.download({
            ownerId: "user-1",
            track: TRACK,
            quality: "auto",
            sourceUrl: "/api/library/tracks/track-1/stream",
        }),
        managerB.download({
            ownerId: "user-1",
            track: TRACK,
            quality: "auto",
            sourceUrl: "/api/library/tracks/track-1/stream",
        }),
    ]);

    assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
    );
    assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
    );
    assert.equal(fetches, 1);
    const winner = [...metadataStore.records.values()][0];
    assert.equal(winner.status, "ready");
    assert.notEqual(winner.key, previous.key);
    assert.ok(
        await audioCache.match(`https://soundspan.test${winner.virtualUrl}`),
    );
    assert.equal(audioCache.responses.size, 1);
});

test("a delete from another manager wins over a completing foreground transfer", async () => {
    const metadataStore = new MemoryMetadataStore();
    const audioCache = new PausedAudioCache();
    const deps = createDependencies({ metadataStore, audioCache });
    const managerA = new DeviceOfflineDownloadManager(deps);
    const managerB = new DeviceOfflineDownloadManager(deps);

    const pending = managerA.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    await audioCache.putStarted;
    const active = [...metadataStore.records.values()][0];
    assert.equal(await managerB.delete("user-1", active.key), true);
    audioCache.resumePut();

    await assert.rejects(pending, /superseded|deleted/i);
    assert.equal(metadataStore.records.has(active.key), false);
    assert.equal(audioCache.responses.size, 0);
});

test("a newer shared-store attempt wins over an older completing manager", async () => {
    const metadataStore = new MemoryMetadataStore();
    const audioCache = new PausedAudioCache();
    const deps = createDependencies({ metadataStore, audioCache });
    const managerA = new DeviceOfflineDownloadManager(deps);

    const pending = managerA.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    await audioCache.putStarted;
    const active = [...metadataStore.records.values()][0];
    const newer = {
        ...active,
        attempt: active.attempt + 1,
        status: "downloading" as const,
        updatedAt: active.updatedAt + 1,
    };
    await metadataStore.put(newer);
    audioCache.resumePut();

    await assert.rejects(pending, /superseded|deleted/i);
    assert.deepEqual(metadataStore.records.get(active.key), newer);
    assert.equal(audioCache.responses.size, 0);
});

test("atomic ready publish cannot overwrite a newer attempt after the final check", async () => {
    const metadataStore = new PausedConditionalMetadataStore(
        (next) => next.status === "ready",
    );
    const audioCache = new MemoryAudioCache();
    const deps = createDependencies({ metadataStore, audioCache });
    const manager = new DeviceOfflineDownloadManager(deps);

    const pending = manager.download({
        ownerId: "user-1",
        track: TRACK,
        quality: "auto",
        sourceUrl: "/api/library/tracks/track-1/stream",
    });
    await metadataStore.updateStarted;
    const active = [...metadataStore.records.values()][0];
    const newer = {
        ...active,
        attempt: active.attempt + 1,
        updatedAt: active.updatedAt + 1,
    };
    await metadataStore.put(newer);
    metadataStore.resumeUpdate();

    await assert.rejects(pending, /superseded|deleted/i);
    assert.deepEqual(metadataStore.records.get(active.key), newer);
    assert.equal(audioCache.responses.size, 0);
});

test("reconcile cannot mark a concurrently resumed attempt interrupted", async () => {
    const metadataStore = new PausedConditionalMetadataStore(
        (next) => next.status === "interrupted",
    );
    const ready: DeviceOfflineDownloadRecord = {
        key: "reconcile-key",
        ownerId: "user-1",
        trackIdentity: "local:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/reconcile-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "ready",
        transferMode: "foreground",
        backgroundFetchId: null,
        bytesReceived: 6,
        totalBytes: 6,
        contentType: "audio/mpeg",
        persistenceGranted: true,
        attempt: 1,
        createdAt: 1,
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    };
    await metadataStore.put(ready);
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({ metadataStore }),
    );

    const pending = manager.reconcile("user-1");
    await metadataStore.updateStarted;
    const resumed: DeviceOfflineDownloadRecord = {
        ...ready,
        status: "downloading",
        attempt: 2,
        bytesReceived: 0,
        totalBytes: null,
        updatedAt: 2,
    };
    await metadataStore.put(resumed);
    metadataStore.resumeUpdate();

    assert.deepEqual(await pending, [resumed]);
    assert.deepEqual(metadataStore.records.get(ready.key), resumed);
});

test("delete removes metadata before aborting registration and cache", async () => {
    const metadataStore = new MemoryMetadataStore();
    const audioCache = new MemoryAudioCache();
    const deps = createDependencies({
        metadataStore,
        audioCache,
        abortBackgroundFetch: async (record) => {
            assert.equal(await metadataStore.getByKey(record.key), null);
            assert.ok(
                await audioCache.match(
                    `https://soundspan.test${record.virtualUrl}`,
                ),
            );
            return "cleared";
        },
    });
    const record: DeviceOfflineDownloadRecord = {
        key: "delete-order-key",
        ownerId: "user-1",
        trackIdentity: "local:track-1",
        quality: "auto",
        virtualUrl: "/__offline/audio/delete-order-key",
        sourceUrl: "/api/library/tracks/track-1/stream",
        track: TRACK,
        status: "downloading",
        transferMode: "background",
        backgroundFetchId: "soundspan-device-audio-delete-order-key::1",
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
    await metadataStore.put(record);
    await audioCache.put(
        `https://soundspan.test${record.virtualUrl}`,
        new Response("partial"),
    );
    const manager = new DeviceOfflineDownloadManager(deps);

    assert.equal(await manager.delete("user-1", record.key), true);
    assert.equal(await metadataStore.getByKey(record.key), null);
    assert.equal(
        await audioCache.match(`https://soundspan.test${record.virtualUrl}`),
        null,
    );
});
