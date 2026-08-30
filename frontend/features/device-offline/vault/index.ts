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
    DeviceAudioDirectoryRegistry,
    DeviceAudioVault,
    DeviceAudioVaultRuntime,
} from "./types";

type DeviceAudioVaultFactory = () => DeviceAudioVault;

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
    if (directoryRuntime.isSupported()) {
        return createBrowserDirectoryDeviceAudioVault({
            registry:
                input.directoryRegistry ??
                createIndexedDbDeviceAudioDirectoryRegistry(),
            runtime: directoryRuntime,
        });
    }
    return createBrowserPrivateDeviceAudioVault({
        storage: input.privateStorage,
        runtime: directoryRuntime,
    });
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
