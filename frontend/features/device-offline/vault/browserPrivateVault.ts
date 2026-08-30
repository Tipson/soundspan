import { createBrowserDirectoryDeviceAudioVault } from "./browserDirectoryVault";
import { createBrowserDeviceAudioVaultRuntime } from "./browserRuntime";
import {
    DeviceAudioVaultError,
    type DeviceAudioAccessRequest,
    type DeviceAudioAccessState,
    type DeviceAudioDirectoryHandle,
    type DeviceAudioDirectoryRegistry,
    type DeviceAudioFileHandle,
    type DeviceAudioVault,
    type DeviceAudioVaultRuntime,
    type DeviceAudioVaultSession,
    type DeviceAudioWritable,
} from "./types";

interface BrowserPrivateWritableLike {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
}

interface BrowserPrivateFileHandleLike {
    readonly kind: "file";
    readonly name: string;
    createWritable?: () => Promise<BrowserPrivateWritableLike>;
    getFile(): Promise<Blob>;
}

interface BrowserPrivateDirectoryHandleLike {
    readonly kind: "directory";
    readonly name: string;
    getDirectoryHandle(
        name: string,
        options?: { create?: boolean },
    ): Promise<BrowserPrivateDirectoryHandleLike>;
    getFileHandle(
        name: string,
        options?: { create?: boolean },
    ): Promise<BrowserPrivateFileHandleLike>;
    removeEntry(name: string): Promise<void>;
}

export interface BrowserPrivateStorageLike {
    getDirectory(): Promise<BrowserPrivateDirectoryHandleLike>;
    persisted?(): Promise<boolean>;
    persist?(): Promise<boolean>;
}

export interface BrowserPrivateDeviceAudioVaultOptions {
    storage?: BrowserPrivateStorageLike | null;
    runtime?: DeviceAudioVaultRuntime;
}

const CAPABILITY_FILE = ".soundspan-write-capability";

function privateStorageReason(persistenceGranted: boolean | null): string {
    if (persistenceGranted === false) {
        return "Офлайн-воспроизведение работает, но браузер не разрешил постоянное хранение. Сохраните обычный файл из раздела «Загрузки», потому что данные браузера могут быть очищены.";
    }
    return "Офлайн-воспроизведение использует закрытое хранилище Soundspan. В разделе «Загрузки» выберите «Сохранить как обычный файл», чтобы создать файл вне браузера.";
}

async function requestPrivatePersistence(
    storage: BrowserPrivateStorageLike,
): Promise<boolean | null> {
    try {
        if (typeof storage.persisted === "function") {
            if (await storage.persisted()) return true;
        }
        return typeof storage.persist === "function"
            ? await storage.persist()
            : null;
    } catch {
        return false;
    }
}

function browserPrivateStorage(): BrowserPrivateStorageLike | null {
    if (typeof navigator === "undefined") return null;
    const storage = navigator.storage as StorageManager &
        Partial<BrowserPrivateStorageLike>;
    return typeof storage?.getDirectory === "function"
        ? (storage as BrowserPrivateStorageLike)
        : null;
}

function wrapFileHandle(
    handle: BrowserPrivateFileHandleLike,
): DeviceAudioFileHandle {
    return {
        kind: "file",
        name: handle.name,
        createWritable: async (): Promise<DeviceAudioWritable> => {
            if (typeof handle.createWritable !== "function") {
                throw new DeviceAudioVaultError(
                    "unsupported",
                    "Этот браузер не может записывать файлы в закрытое хранилище устройства.",
                    "none",
                );
            }
            const writable = await handle.createWritable();
            return {
                write: (chunk) => writable.write(chunk),
                close: () => writable.close(),
                abort:
                    typeof writable.abort === "function"
                        ? () => writable.abort!()
                        : undefined,
            };
        },
        getFile: () => handle.getFile(),
    };
}

function wrapDirectoryHandle(
    handle: BrowserPrivateDirectoryHandleLike,
): DeviceAudioDirectoryHandle {
    return {
        kind: "directory",
        name: handle.name,
        queryPermission: async () => "granted",
        requestPermission: async () => "granted",
        getDirectoryHandle: async (name, options) =>
            wrapDirectoryHandle(await handle.getDirectoryHandle(name, options)),
        getFileHandle: async (name, options) =>
            wrapFileHandle(await handle.getFileHandle(name, options)),
        removeEntry: (name) => handle.removeEntry(name),
    };
}

async function requireWritableRoot(
    storage: BrowserPrivateStorageLike,
): Promise<{
    root: DeviceAudioDirectoryHandle;
    persistenceGranted: boolean | null;
}> {
    const persistenceGranted = await requestPrivatePersistence(storage);
    const root = await storage.getDirectory();
    let writable: BrowserPrivateWritableLike | null = null;
    try {
        const capability = await root.getFileHandle(CAPABILITY_FILE, {
            create: true,
        });
        if (typeof capability.createWritable !== "function") {
            throw new DeviceAudioVaultError(
                "unsupported",
                "Этот браузер не может записывать файлы в закрытое хранилище устройства.",
                "none",
            );
        }
        writable = await capability.createWritable();
        await writable.write(new Uint8Array(0));
        await writable.close();
        writable = null;
    } catch (error) {
        if (writable && typeof writable.abort === "function") {
            await writable.abort().catch(() => undefined);
        }
        if (error instanceof DeviceAudioVaultError) throw error;
        throw new DeviceAudioVaultError(
            "unsupported",
            "Этот браузер не может записывать файлы в закрытое хранилище устройства.",
            "none",
            { cause: error },
        );
    } finally {
        await root.removeEntry(CAPABILITY_FILE).catch(() => undefined);
    }
    return {
        root: wrapDirectoryHandle(root),
        persistenceGranted,
    };
}

function decorateAccessState(
    state: DeviceAudioAccessState,
    persistenceGranted: boolean | null,
): DeviceAudioAccessState {
    return state.status === "ready" && state.storageKind === "browser-private"
        ? {
              ...state,
              reason: privateStorageReason(persistenceGranted),
          }
        : state;
}

/**
 * OPFS-backed fallback for browsers that cannot expose a user-selected folder.
 * Files remain local to this browser profile/device and are owner-scoped.
 */
export function createBrowserPrivateDeviceAudioVault(
    input: BrowserPrivateDeviceAudioVaultOptions = {},
): DeviceAudioVault {
    const storage =
        input.storage === null
            ? null
            : (input.storage ?? browserPrivateStorage());
    const baseRuntime = input.runtime ?? createBrowserDeviceAudioVaultRuntime();
    let rootPromise: Promise<DeviceAudioDirectoryHandle> | null = null;
    let persistenceGranted: boolean | null = null;
    const loadRoot = (): Promise<DeviceAudioDirectoryHandle> => {
        if (!storage) {
            return Promise.reject(
                new DeviceAudioVaultError(
                    "unsupported",
                    "Закрытое хранилище устройства недоступно.",
                    "none",
                ),
            );
        }
        rootPromise ??= requireWritableRoot(storage)
            .then((result) => {
                persistenceGranted = result.persistenceGranted;
                return result.root;
            })
            .catch((error: unknown) => {
                rootPromise = null;
                throw error;
            });
        return rootPromise;
    };
    const runtime: DeviceAudioVaultRuntime = {
        ...baseRuntime,
        isSupported: () => storage !== null,
        pickDirectory: loadRoot,
    };
    const registry: DeviceAudioDirectoryRegistry = {
        load: loadRoot,
        save: async () => undefined,
    };
    const delegate = createBrowserDirectoryDeviceAudioVault({
        registry,
        runtime,
        presentation: {
            storageKind: "browser-private",
            mediaRefVersion: "opfs1",
            readyLabel: "Soundspan на этом устройстве",
            readyReason: privateStorageReason(null),
        },
    });
    const wrapSession = (
        session: DeviceAudioVaultSession,
    ): DeviceAudioVaultSession => ({
        ownerId: session.ownerId,
        authGeneration: session.authGeneration,
        storage: session.storage,
        retain: async (retainInput) => ({
            ...(await session.retain(retainInput)),
            persistenceGranted,
        }),
        access: <T extends DeviceAudioAccessRequest>(accessInput: T) =>
            session.access(accessInput),
    });
    return {
        inspectAccess: async () =>
            decorateAccessState(
                await delegate.inspectAccess(),
                persistenceGranted,
            ),
        requestAccess: async () =>
            decorateAccessState(
                await delegate.requestAccess(),
                persistenceGranted,
            ),
        open: async (openInput) => wrapSession(await delegate.open(openInput)),
    };
}
