import assert from "node:assert/strict";
import test from "node:test";
import {
    clampForegroundLeaseClockSkew,
    DEVICE_OFFLINE_BACKGROUND_MISSING_GRACE_MS,
    DEVICE_OFFLINE_BACKGROUND_UNKNOWN_RETRY_LIMIT,
    DEVICE_OFFLINE_FOREGROUND_LEASE_TTL_MS,
    DeviceOfflineDownloadManager,
    foregroundLeaseDisposition,
    interruptExpiredForegroundRecord,
    matchesDeviceOfflineRecordVersion,
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
    ): Promise<boolean> {
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
    ): Promise<boolean> {
        if (
            !matchesDeviceOfflineRecordVersion(
                this.records.get(expected.key) ?? null,
                expected,
            )
        ) {
            return false;
        }
        await this.put(next);
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
    ): Promise<boolean> {
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

function createDependencies(
    overrides: Partial<DeviceOfflineManagerDependencies> = {},
): DeviceOfflineManagerDependencies & {
    metadataStore: MemoryMetadataStore;
    audioCache: MemoryAudioCache;
} {
    const metadataStore = new MemoryMetadataStore();
    const audioCache = new MemoryAudioCache();
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
        abortBackgroundFetch: async () => undefined,
        listActiveBackgroundFetches: async () => [],
        scheduleLeaseHeartbeat: () => Symbol("lease-heartbeat"),
        cancelLeaseHeartbeat: () => undefined,
        scheduleLeaseExpiryCheck: () => Symbol("lease-expiry-check"),
        cancelLeaseExpiryCheck: () => undefined,
        ...overrides,
        metadataStore: overrides.metadataStore ?? metadataStore,
        audioCache: overrides.audioCache ?? audioCache,
    } as DeviceOfflineManagerDependencies & {
        metadataStore: MemoryMetadataStore;
        audioCache: MemoryAudioCache;
    };
}

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

test("records and playback resolution are isolated by owner and quality", async () => {
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
        high.virtualUrl,
    );

    setDeviceOfflineRuntimeState("user-2", [otherOwner]);
    assert.equal(
        resolveDeviceOfflinePlaybackUrl(
            TRACK,
            "https://soundspan.test/api/library/tracks/track-1/stream",
            "high",
        ),
        otherOwner.virtualUrl,
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
    assert.equal(confirmed.foregroundLeaseId, null);
    assert.equal(confirmed.foregroundLeaseExpiresAt, null);
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
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    };
    await metadataStore.put(record);
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({
            metadataStore,
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
        updatedAt: 1,
        errorCode: null,
        errorMessage: null,
    };
    await metadataStore.put(record);
    const manager = new DeviceOfflineDownloadManager(
        createDependencies({
            metadataStore,
            backgroundFetchLookupTimeoutMs: 5,
            listActiveBackgroundFetches: () =>
                new Promise<never>(() => undefined),
        }),
    );

    assert.deepEqual(await manager.reconcile("user-1"), [record]);
    assert.deepEqual(metadataStore.records.get(record.key), record);
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
