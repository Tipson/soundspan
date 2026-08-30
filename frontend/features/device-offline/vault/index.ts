export { createBrowserDirectoryDeviceAudioVault } from "./browserDirectoryVault";
export {
    createBrowserPrivateDeviceAudioVault,
    type BrowserPrivateDeviceAudioVaultOptions,
    type BrowserPrivateStorageLike,
} from "./browserPrivateVault";
export { createBrowserDeviceAudioVaultRuntime } from "./browserRuntime";
export { createIndexedDbDeviceAudioDirectoryRegistry } from "./indexedDbDirectoryRegistry";
export {
    DeviceAudioVaultError,
    type DeviceAudioAccessRequest,
    type DeviceAudioAccessResult,
    type DeviceAudioAccessState,
    type DeviceAudioDirectoryHandle,
    type DeviceAudioDirectoryRegistry,
    type DeviceAudioExportRequest,
    type DeviceAudioExportResult,
    type DeviceAudioFileHandle,
    type DeviceAudioInspectRequest,
    type DeviceAudioInspectResult,
    type DeviceAudioPlayRequest,
    type DeviceAudioPlayResult,
    type DeviceAudioReceipt,
    type DeviceAudioRemoveRequest,
    type DeviceAudioRemoveResult,
    type DeviceAudioRetainInput,
    type DeviceAudioStorageKind,
    type DeviceAudioTrackDescriptor,
    type DeviceAudioVault,
    type DeviceAudioVaultErrorCode,
    type DeviceAudioVaultRef,
    type DeviceAudioVaultRuntime,
    type DeviceAudioVaultSession,
    type DeviceAudioWritable,
} from "./types";

import { createBrowserDirectoryDeviceAudioVault } from "./browserDirectoryVault";
import {
    createBrowserPrivateDeviceAudioVault,
    type BrowserPrivateStorageLike,
} from "./browserPrivateVault";
import { createBrowserDeviceAudioVaultRuntime } from "./browserRuntime";
import { createIndexedDbDeviceAudioDirectoryRegistry } from "./indexedDbDirectoryRegistry";
import type {
    DeviceAudioAccessRequest,
    DeviceAudioAccessResult,
    DeviceAudioAccessState,
    DeviceAudioDirectoryRegistry,
    DeviceAudioVault,
    DeviceAudioVaultRuntime,
    DeviceAudioVaultSession,
} from "./types";

type DeviceAudioVaultFactory = () => DeviceAudioVault;

function hasRetainedDirectory(access: DeviceAudioAccessState): boolean {
    return (
        access.status === "ready" ||
        access.status === "permission-required" ||
        access.status === "denied"
    );
}

export interface BrowserDeviceAudioVaultOptions {
    directoryRegistry?: DeviceAudioDirectoryRegistry;
    directoryRuntime?: DeviceAudioVaultRuntime;
    privateStorage?: BrowserPrivateStorageLike | null;
}

/** Prefer normal user-visible files, using private per-device storage only when required. */
export function createBrowserDeviceAudioVault(
    input: BrowserDeviceAudioVaultOptions = {},
): DeviceAudioVault {
    const directoryRuntime =
        input.directoryRuntime ?? createBrowserDeviceAudioVaultRuntime();
    const directoryRegistry =
        input.directoryRegistry ??
        createIndexedDbDeviceAudioDirectoryRegistry();
    const directoryVault = createBrowserDirectoryDeviceAudioVault({
        registry: directoryRegistry,
        runtime: directoryRuntime,
    });
    const retainedDirectoryVault = directoryRuntime.isSupported()
        ? directoryVault
        : createBrowserDirectoryDeviceAudioVault({
              registry: directoryRegistry,
              runtime: {
                  ...directoryRuntime,
                  // A persisted handle can remain readable in an installed PWA
                  // even when that window no longer exposes the picker entrypoint.
                  isSupported: () => true,
              },
          });
    const privateVault = createBrowserPrivateDeviceAudioVault({
        storage: input.privateStorage,
        runtime: directoryRuntime,
    });

    const writeVault = async (): Promise<DeviceAudioVault> => {
        const directoryAccess = await retainedDirectoryVault.inspectAccess();
        if (
            hasRetainedDirectory(directoryAccess) ||
            directoryRuntime.isSupported()
        ) {
            return retainedDirectoryVault;
        }
        return privateVault;
    };
    const accessVault = (
        request: DeviceAudioAccessRequest,
    ): DeviceAudioVault => {
        const version = String(request.ref).split(":", 1)[0];
        if (version === "fsa1") return retainedDirectoryVault;
        if (version === "opfs1") return privateVault;
        return directoryRuntime.isSupported() ? directoryVault : privateVault;
    };

    return {
        inspectAccess: async () => {
            const directoryAccess =
                await retainedDirectoryVault.inspectAccess();
            if (
                hasRetainedDirectory(directoryAccess) ||
                directoryRuntime.isSupported()
            ) {
                return directoryAccess;
            }
            return privateVault.inspectAccess();
        },
        requestAccess: async () => {
            // Preserve the user's transient activation: when a picker exists,
            // invoke it without first awaiting IndexedDB or OPFS work.
            if (directoryRuntime.isSupported()) {
                return directoryVault.requestAccess();
            }
            const directoryAccess =
                await retainedDirectoryVault.inspectAccess();
            if (hasRetainedDirectory(directoryAccess)) {
                return retainedDirectoryVault.requestAccess();
            }
            return privateVault.requestAccess();
        },
        open: async (openInput): Promise<DeviceAudioVaultSession> => ({
            ownerId: openInput.ownerId,
            authGeneration: openInput.authGeneration,
            storage: {
                kind: directoryRuntime.isSupported()
                    ? "desktop-directory"
                    : "browser-private",
                label: directoryRuntime.isSupported()
                    ? "Selected folder"
                    : "Soundspan on this device",
            },
            retain: async (retainInput) => {
                const selected = await writeVault();
                const session = await selected.open(openInput);
                return session.retain(retainInput);
            },
            access: async <T extends DeviceAudioAccessRequest>(
                accessInput: T,
            ): Promise<DeviceAudioAccessResult<T>> => {
                const session = await accessVault(accessInput).open(openInput);
                return session.access(accessInput);
            },
        }),
    };
}

const defaultFactory: DeviceAudioVaultFactory = createBrowserDeviceAudioVault;

let installedFactory: DeviceAudioVaultFactory = defaultFactory;
let singleton: DeviceAudioVault | null = null;

/** Return the process-local vault selected by the application composition root. */
export function getDeviceAudioVault(): DeviceAudioVault {
    singleton ??= installedFactory();
    return singleton;
}

/** Install another platform adapter, including a future native mobile vault. */
export function installDeviceAudioVaultFactory(
    factory: DeviceAudioVaultFactory,
): () => void {
    const previousFactory = installedFactory;
    const previousSingleton = singleton;
    installedFactory = factory;
    singleton = null;
    let restored = false;
    return () => {
        if (restored) return;
        restored = true;
        installedFactory = previousFactory;
        singleton = previousSingleton;
    };
}
