import { isCurrentAuthRuntime } from "@/lib/auth-runtime-generation";
import type {
    DeviceAudioDirectoryHandle,
    DeviceAudioVaultRuntime,
} from "./types";

interface FileSystemAccessGlobal {
    showDirectoryPicker?: (options?: {
        id?: string;
        mode?: "read" | "readwrite";
        startIn?: string;
    }) => Promise<DeviceAudioDirectoryHandle>;
}

function browserGlobal(): FileSystemAccessGlobal {
    return globalThis as typeof globalThis & FileSystemAccessGlobal;
}

function cryptoRuntime(): Crypto | null {
    return typeof globalThis.crypto === "undefined" ? null : globalThis.crypto;
}

function opaqueId(): string {
    const runtime = cryptoRuntime();
    if (typeof runtime?.randomUUID === "function") {
        return runtime.randomUUID();
    }
    if (!runtime?.getRandomValues) {
        throw new Error("Secure random values are unavailable");
    }
    const bytes = new Uint8Array(24);
    runtime.getRandomValues(bytes);
    return Array.from(bytes, (value) =>
        value.toString(16).padStart(2, "0"),
    ).join("");
}

async function ownerScope(ownerId: string): Promise<string> {
    const runtime = cryptoRuntime();
    if (!runtime?.subtle) {
        throw new Error("Web Crypto is unavailable");
    }
    const digest = await runtime.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(ownerId),
    );
    const token = Array.from(new Uint8Array(digest).slice(0, 16), (value) =>
        value.toString(16).padStart(2, "0"),
    ).join("");
    return `owner-${token}`;
}

/** Browser-backed runtime kept separate from the adapter for Node tests. */
export function createBrowserDeviceAudioVaultRuntime(): DeviceAudioVaultRuntime {
    return {
        isSupported: () =>
            typeof browserGlobal().showDirectoryPicker === "function",
        pickDirectory: () => {
            const picker = browserGlobal().showDirectoryPicker;
            if (!picker) {
                throw new Error("File System Access is unavailable");
            }
            return picker.call(globalThis, {
                id: "soundspan-device-audio",
                mode: "readwrite",
                startIn: "music",
            });
        },
        createObjectUrl: (file) => URL.createObjectURL(file),
        revokeObjectUrl: (url) => URL.revokeObjectURL(url),
        createOpaqueId: opaqueId,
        ownerScope,
        isAuthGenerationCurrent: isCurrentAuthRuntime,
    };
}
