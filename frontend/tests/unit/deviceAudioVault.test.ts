import assert from "node:assert/strict";
import test from "node:test";
import {
    DeviceAudioVaultError,
    createBrowserDirectoryDeviceAudioVault,
    type DeviceAudioDirectoryHandle,
    type DeviceAudioDirectoryRegistry,
    type DeviceAudioFileHandle,
    type DeviceAudioVaultRuntime,
    type DeviceAudioWritable,
    createIndexedDbDeviceAudioDirectoryRegistry,
} from "../../features/device-offline/vault";

class MemoryFileHandle implements DeviceAudioFileHandle {
    readonly kind = "file" as const;
    private bytes = new Uint8Array();
    private contentType = "";
    onClose: (() => void) | null = null;

    constructor(readonly name: string) {}

    async createWritable(): Promise<DeviceAudioWritable> {
        const chunks: Uint8Array[] = [];
        let aborted = false;
        return {
            write: async (chunk) => {
                if (aborted) throw new Error("writer aborted");
                chunks.push(Uint8Array.from(chunk));
            },
            close: async () => {
                if (aborted) throw new Error("writer aborted");
                const length = chunks.reduce(
                    (total, chunk) => total + chunk.byteLength,
                    0,
                );
                this.bytes = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                    this.bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                this.onClose?.();
            },
            abort: async () => {
                aborted = true;
            },
        };
    }

    async getFile(): Promise<Blob> {
        return new Blob([this.bytes], { type: this.contentType });
    }

    setContentType(value: string): void {
        this.contentType = value;
    }

    snapshot(): number[] {
        return [...this.bytes];
    }
}

class MemoryDirectoryHandle implements DeviceAudioDirectoryHandle {
    readonly kind = "directory" as const;
    readonly directories = new Map<string, MemoryDirectoryHandle>();
    readonly files = new Map<string, MemoryFileHandle>();
    permission: PermissionState = "granted";
    requestedPermission: PermissionState = "granted";
    queryCalls = 0;
    requestCalls = 0;
    onFileCreated: ((file: MemoryFileHandle) => void) | null = null;

    constructor(readonly name: string) {}

    async queryPermission(): Promise<PermissionState> {
        this.queryCalls += 1;
        return this.permission;
    }

    async requestPermission(): Promise<PermissionState> {
        this.requestCalls += 1;
        this.permission = this.requestedPermission;
        return this.permission;
    }

    async getDirectoryHandle(
        name: string,
        options?: { create?: boolean },
    ): Promise<MemoryDirectoryHandle> {
        const existing = this.directories.get(name);
        if (existing) return existing;
        if (!options?.create) throw notFound();
        const created = new MemoryDirectoryHandle(name);
        created.permission = this.permission;
        this.directories.set(name, created);
        return created;
    }

    async getFileHandle(
        name: string,
        options?: { create?: boolean },
    ): Promise<MemoryFileHandle> {
        const existing = this.files.get(name);
        if (existing) return existing;
        if (!options?.create) throw notFound();
        const created = new MemoryFileHandle(name);
        this.files.set(name, created);
        this.onFileCreated?.(created);
        return created;
    }

    async removeEntry(name: string): Promise<void> {
        if (!this.files.delete(name) && !this.directories.delete(name)) {
            throw notFound();
        }
    }
}

class MemoryRegistry implements DeviceAudioDirectoryRegistry {
    loaded = false;
    saved: DeviceAudioDirectoryHandle | null = null;

    constructor(private handle: DeviceAudioDirectoryHandle | null = null) {}

    async load(): Promise<DeviceAudioDirectoryHandle | null> {
        this.loaded = true;
        return this.handle;
    }

    async save(handle: DeviceAudioDirectoryHandle): Promise<void> {
        this.saved = handle;
        this.handle = handle;
    }
}

function notFound(): DOMException {
    return new DOMException("Entry not found", "NotFoundError");
}

function bytesStream(...chunks: number[][]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(Uint8Array.from(chunk));
            }
            controller.close();
        },
    });
}

function createHarness(options?: {
    supported?: boolean;
    persisted?: MemoryDirectoryHandle | null;
    picked?: MemoryDirectoryHandle;
    order?: string[];
    isAuthGenerationCurrent?: (generation: number) => boolean;
}) {
    const registry = new MemoryRegistry(options?.persisted ?? null);
    const picked = options?.picked ?? new MemoryDirectoryHandle("Music");
    const createdUrls: Blob[] = [];
    const revokedUrls: string[] = [];
    let opaqueCounter = 0;
    const runtime: DeviceAudioVaultRuntime = {
        isSupported: () => options?.supported ?? true,
        pickDirectory: () => {
            options?.order?.push("picker");
            return Promise.resolve(picked);
        },
        createObjectUrl: (file) => {
            createdUrls.push(file);
            return `blob:soundspan/${createdUrls.length}`;
        },
        revokeObjectUrl: (url) => revokedUrls.push(url),
        createOpaqueId: () => `opaque${++opaqueCounter}`,
        ownerScope: async (ownerId) => `scope-${ownerId}`,
        isAuthGenerationCurrent:
            options?.isAuthGenerationCurrent ?? (() => true),
    };
    return {
        registry,
        picked,
        createdUrls,
        revokedUrls,
        vault: createBrowserDirectoryDeviceAudioVault({ registry, runtime }),
    };
}

const TRACK = {
    id: "track-1",
    title: "A/B: Song?* <Live>",
    artist: { id: "artist-1", name: 'AC\\DC | "Band"' },
    album: { id: "album-1", title: "Album" },
    duration: 180,
};

test("inspectAccess reports explicit unsupported and setup-required states without prompting", async () => {
    const unsupported = createHarness({ supported: false });
    assert.deepEqual(await unsupported.vault.inspectAccess(), {
        status: "unsupported",
        code: "unsupported",
        storageKind: null,
        label: "Device files unavailable",
        reason: "This browser cannot write to a user-selected directory.",
    });
    assert.equal(unsupported.registry.loaded, false);

    const missing = createHarness();
    assert.deepEqual(await missing.vault.inspectAccess(), {
        status: "setup-required",
        code: "setup_required",
        storageKind: "desktop-directory",
        label: "Choose a music folder",
        reason: "Choose a folder before downloading files to this device.",
    });
    assert.equal(missing.picked.queryCalls, 0);
});

test("inspectAccess never requests permission, while requestAccess reuses a persisted handle", async () => {
    const persisted = new MemoryDirectoryHandle("Soundspan Music");
    persisted.permission = "prompt";
    persisted.requestedPermission = "granted";
    const { vault, picked, registry } = createHarness({ persisted });

    assert.deepEqual(await vault.inspectAccess(), {
        status: "permission-required",
        code: "permission_required",
        storageKind: "desktop-directory",
        label: "Soundspan Music",
        reason: "Allow Soundspan to write to the selected folder.",
    });
    assert.equal(persisted.requestCalls, 0);

    assert.deepEqual(await vault.requestAccess(), {
        status: "ready",
        code: null,
        storageKind: "desktop-directory",
        label: "Soundspan Music",
        reason: "Music files are stored in the selected folder.",
    });
    assert.equal(persisted.requestCalls, 1);
    assert.equal(registry.saved, null);
    assert.notEqual(persisted, picked);
});

test("requestAccess invokes the directory picker before unrelated registry work", async () => {
    const order: string[] = [];
    const registry: DeviceAudioDirectoryRegistry = {
        load: async () => {
            order.push("registry-load");
            return null;
        },
        save: async () => {
            order.push("registry-save");
        },
    };
    const root = new MemoryDirectoryHandle("Music");
    const runtime: DeviceAudioVaultRuntime = {
        isSupported: () => true,
        pickDirectory: () => {
            order.push("picker");
            return Promise.resolve(root);
        },
        createObjectUrl: () => "blob:test",
        revokeObjectUrl: () => undefined,
        createOpaqueId: () => "opaque",
        ownerScope: async () => "scope-user",
        isAuthGenerationCurrent: () => true,
    };
    const vault = createBrowserDirectoryDeviceAudioVault({
        registry,
        runtime,
    });

    const accessPromise = vault.requestAccess();
    assert.deepEqual(order, ["picker"]);
    assert.equal((await accessPromise).status, "ready");
    assert.deepEqual(order, ["picker", "registry-save"]);
});

test("retain streams bytes into a safe readable real file and returns an owner-scoped opaque ref", async () => {
    const progress: Array<[number, number | null]> = [];
    const { vault, picked } = createHarness();
    await vault.requestAccess();
    const session = await vault.open({ ownerId: "user-1", authGeneration: 7 });

    const receipt = await session.retain({
        track: TRACK,
        quality: "auto",
        stream: bytesStream([1, 2], [3, 4, 5]),
        contentType: "audio/mpeg",
        expectedBytes: 5,
        onProgress: (bytes, total) => progress.push([bytes, total]),
    });

    assert.equal(receipt.bytes, 5);
    assert.equal(receipt.contentType, "audio/mpeg");
    assert.match(
        receipt.displayName,
        /^AC DC Band - A B Song Live -- opaque1\.mp3$/,
    );
    assert.match(receipt.ref, /^fsa1:scope-user-1:/);
    assert.deepEqual(progress, [
        [2, 5],
        [5, 5],
    ]);

    const soundspan = picked.directories.get("Soundspan");
    const owner = soundspan?.directories.get("scope-user-1");
    const tracks = owner?.directories.get("tracks");
    const stored = tracks?.files.get(receipt.displayName);
    assert.ok(stored);
    assert.deepEqual(stored.snapshot(), [1, 2, 3, 4, 5]);
});

test("access inspects, opens a revocable Blob URL, rejects another owner, and removes idempotently", async () => {
    const { vault, createdUrls, revokedUrls } = createHarness();
    await vault.requestAccess();
    const ownerOne = await vault.open({ ownerId: "user-1", authGeneration: 1 });
    const ownerTwo = await vault.open({ ownerId: "user-2", authGeneration: 1 });
    const receipt = await ownerOne.retain({
        track: TRACK,
        quality: "auto",
        stream: bytesStream([7, 8, 9]),
        contentType: "audio/webm",
        expectedBytes: 3,
    });

    assert.deepEqual(
        await ownerOne.access({
            kind: "inspect",
            ref: receipt.ref,
            expectedBytes: 3,
        }),
        { kind: "inspect", exists: true, bytes: 3 },
    );
    const playback = await ownerOne.access({
        kind: "play",
        ref: receipt.ref,
        expectedBytes: 3,
    });
    assert.equal(playback.kind, "play");
    assert.equal(playback.url, "blob:soundspan/1");
    assert.equal(createdUrls[0].size, 3);
    playback.release();
    playback.release();
    assert.deepEqual(revokedUrls, ["blob:soundspan/1"]);

    await assert.rejects(
        ownerTwo.access({ kind: "play", ref: receipt.ref }),
        (error: unknown) =>
            error instanceof DeviceAudioVaultError &&
            error.code === "owner_mismatch",
    );

    assert.deepEqual(
        await ownerOne.access({ kind: "remove", ref: receipt.ref }),
        { kind: "remove", removed: true },
    );
    assert.deepEqual(
        await ownerOne.access({ kind: "remove", ref: receipt.ref }),
        { kind: "remove", removed: false },
    );
    assert.deepEqual(
        await ownerOne.access({ kind: "inspect", ref: receipt.ref }),
        { kind: "inspect", exists: false, bytes: null },
    );
});

test("a retain receipt can discard its exact file after the auth generation changes", async () => {
    let authCurrent = true;
    const { vault, picked } = createHarness({
        isAuthGenerationCurrent: () => authCurrent,
    });
    await vault.requestAccess();
    const session = await vault.open({ ownerId: "user-1", authGeneration: 1 });
    const receipt = await session.retain({
        track: TRACK,
        quality: "auto",
        stream: bytesStream([1, 2, 3]),
        contentType: "audio/mpeg",
        expectedBytes: 3,
    });
    const tracks = picked.directories
        .get("Soundspan")
        ?.directories.get("scope-user-1")
        ?.directories.get("tracks");
    assert.equal(tracks?.files.size, 1);

    authCurrent = false;
    await receipt.discard();
    await receipt.discard();
    assert.equal(tracks?.files.size, 0);
});

test("retain removes an incomplete file and reports a stable integrity code", async () => {
    const { vault, picked } = createHarness();
    await vault.requestAccess();
    const session = await vault.open({ ownerId: "user-1", authGeneration: 1 });

    await assert.rejects(
        session.retain({
            track: TRACK,
            quality: "auto",
            stream: bytesStream([1, 2, 3]),
            contentType: "audio/mp4",
            expectedBytes: 6,
        }),
        (error: unknown) =>
            error instanceof DeviceAudioVaultError &&
            error.code === "integrity",
    );
    const tracks = picked.directories
        .get("Soundspan")
        ?.directories.get("scope-user-1")
        ?.directories.get("tracks");
    assert.equal(tracks?.files.size, 0);
});

test("open and retain expose permission and interrupted errors without browser storage fallback", async () => {
    const deniedRoot = new MemoryDirectoryHandle("Denied");
    deniedRoot.permission = "denied";
    const denied = createHarness({ persisted: deniedRoot });
    await assert.rejects(
        denied.vault.open({ ownerId: "user-1", authGeneration: 1 }),
        (error: unknown) =>
            error instanceof DeviceAudioVaultError &&
            error.code === "permission_denied",
    );

    const ready = createHarness();
    await ready.vault.requestAccess();
    const session = await ready.vault.open({
        ownerId: "user-1",
        authGeneration: 1,
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        session.retain({
            track: TRACK,
            quality: "auto",
            stream: bytesStream([1, 2, 3]),
            contentType: "audio/mpeg",
            signal: controller.signal,
        }),
        (error: unknown) =>
            error instanceof DeviceAudioVaultError &&
            error.code === "interrupted",
    );
});

test("retain removes a just-closed file when auth or cancellation changes during close", async () => {
    let authCurrent = true;
    const auth = createHarness({
        isAuthGenerationCurrent: () => authCurrent,
    });
    await auth.vault.requestAccess();
    const authSession = await auth.vault.open({
        ownerId: "user-1",
        authGeneration: 1,
    });
    const authTracks = auth.picked.directories
        .get("Soundspan")
        ?.directories.get("scope-user-1")
        ?.directories.get("tracks");
    assert.ok(authTracks);
    authTracks.onFileCreated = (file) => {
        file.onClose = () => {
            authCurrent = false;
        };
    };

    await assert.rejects(
        authSession.retain({
            track: TRACK,
            quality: "auto",
            stream: bytesStream([1, 2, 3]),
            contentType: "audio/mpeg",
            expectedBytes: 3,
        }),
        (error: unknown) =>
            error instanceof DeviceAudioVaultError &&
            error.code === "auth_changed",
    );
    assert.equal(authTracks.files.size, 0);

    const cancellation = createHarness();
    await cancellation.vault.requestAccess();
    const cancelledSession = await cancellation.vault.open({
        ownerId: "user-1",
        authGeneration: 1,
    });
    const cancelledTracks = cancellation.picked.directories
        .get("Soundspan")
        ?.directories.get("scope-user-1")
        ?.directories.get("tracks");
    assert.ok(cancelledTracks);
    const controller = new AbortController();
    cancelledTracks.onFileCreated = (file) => {
        file.onClose = () => controller.abort();
    };
    await assert.rejects(
        cancelledSession.retain({
            track: TRACK,
            quality: "auto",
            stream: bytesStream([1, 2, 3]),
            contentType: "audio/mpeg",
            expectedBytes: 3,
            signal: controller.signal,
        }),
        (error: unknown) =>
            error instanceof DeviceAudioVaultError &&
            error.code === "interrupted",
    );
    assert.equal(cancelledTracks.files.size, 0);
});

test("the IndexedDB registry retries a failed open and then persists the selected handle", async (t) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    t.after(() => {
        if (original) Object.defineProperty(globalThis, "indexedDB", original);
        else Reflect.deleteProperty(globalThis, "indexedDB");
    });

    let openCalls = 0;
    let stored: unknown;
    const database = {
        onversionchange: null as (() => void) | null,
        close: () => undefined,
        objectStoreNames: { contains: () => true },
        createObjectStore: () => undefined,
        transaction: () => {
            const transaction = {
                oncomplete: null as (() => void) | null,
                onerror: null as (() => void) | null,
                onabort: null as (() => void) | null,
                error: null,
                objectStore: () => ({
                    get: () => {
                        const request = {
                            result: stored,
                            error: null,
                            onsuccess: null as (() => void) | null,
                            onerror: null as (() => void) | null,
                        };
                        queueMicrotask(() => request.onsuccess?.());
                        return request;
                    },
                    put: (value: unknown) => {
                        stored = value;
                        queueMicrotask(() => transaction.oncomplete?.());
                    },
                }),
            };
            return transaction;
        },
    };
    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: {
            open: () => {
                openCalls += 1;
                const request = {
                    result: database,
                    error:
                        openCalls === 1 ? new Error("first open failed") : null,
                    onupgradeneeded: null as (() => void) | null,
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null,
                    onblocked: null as (() => void) | null,
                };
                queueMicrotask(() => {
                    if (request.error) request.onerror?.();
                    else request.onsuccess?.();
                });
                return request;
            },
        },
    });

    const registry = createIndexedDbDeviceAudioDirectoryRegistry();
    await assert.rejects(registry.load(), /first open failed/);
    const root = new MemoryDirectoryHandle("Music");
    await registry.save(root);
    assert.equal(await registry.load(), root);
    assert.equal(openCalls, 2);
});
