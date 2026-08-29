export { createBrowserDirectoryDeviceAudioVault } from "./browserDirectoryVault";
export { createBrowserDeviceAudioVaultRuntime } from "./browserRuntime";
export { createIndexedDbDeviceAudioDirectoryRegistry } from "./indexedDbDirectoryRegistry";
export {
    DeviceAudioVaultError,
    type DeviceAudioAccessRequest,
    type DeviceAudioAccessResult,
    type DeviceAudioAccessState,
    type DeviceAudioDirectoryHandle,
    type DeviceAudioDirectoryRegistry,
    type DeviceAudioFileHandle,
    type DeviceAudioInspectRequest,
    type DeviceAudioInspectResult,
    type DeviceAudioPlayRequest,
    type DeviceAudioPlayResult,
    type DeviceAudioReceipt,
    type DeviceAudioRemoveRequest,
    type DeviceAudioRemoveResult,
    type DeviceAudioRetainInput,
    type DeviceAudioTrackDescriptor,
    type DeviceAudioVault,
    type DeviceAudioVaultErrorCode,
    type DeviceAudioVaultRef,
    type DeviceAudioVaultRuntime,
    type DeviceAudioVaultSession,
    type DeviceAudioWritable,
} from "./types";

import { createBrowserDirectoryDeviceAudioVault } from "./browserDirectoryVault";
import { createBrowserDeviceAudioVaultRuntime } from "./browserRuntime";
import { createIndexedDbDeviceAudioDirectoryRegistry } from "./indexedDbDirectoryRegistry";
import type { DeviceAudioVault } from "./types";

type DeviceAudioVaultFactory = () => DeviceAudioVault;

const defaultFactory: DeviceAudioVaultFactory = () =>
    createBrowserDirectoryDeviceAudioVault({
        registry: createIndexedDbDeviceAudioDirectoryRegistry(),
        runtime: createBrowserDeviceAudioVaultRuntime(),
    });

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
