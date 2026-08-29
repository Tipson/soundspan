/** Opaque, owner-scoped reference to one real device audio file. */
export type DeviceAudioVaultRef = string & {
    readonly __deviceAudioVaultRef: unique symbol;
};

export type DeviceAudioVaultErrorCode =
    | "unsupported"
    | "setup_required"
    | "permission_required"
    | "permission_denied"
    | "user_cancelled"
    | "invalid_owner"
    | "invalid_ref"
    | "owner_mismatch"
    | "auth_changed"
    | "not_found"
    | "integrity"
    | "storage_full"
    | "interrupted"
    | "io";

export type DeviceAudioVaultRecovery = "retry" | "user-action" | "none";

/** Stable error contract shared by platform adapters and callers. */
export class DeviceAudioVaultError extends Error {
    constructor(
        readonly code: DeviceAudioVaultErrorCode,
        message: string,
        readonly recovery: DeviceAudioVaultRecovery,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "DeviceAudioVaultError";
    }
}

export type DeviceAudioAccessState = {
    status:
        | "ready"
        | "setup-required"
        | "permission-required"
        | "denied"
        | "unsupported"
        | "error";
    code:
        | null
        | "setup_required"
        | "permission_required"
        | "permission_denied"
        | "unsupported"
        | "io";
    storageKind: "desktop-directory" | null;
    label: string;
    reason: string;
};

/** Only the metadata needed to create a safe, readable device filename. */
export interface DeviceAudioTrackDescriptor {
    title: string;
    artist: { name: string };
}

export interface DeviceAudioRetainInput {
    track: DeviceAudioTrackDescriptor;
    quality: string;
    stream: ReadableStream<Uint8Array>;
    contentType: string | null;
    expectedBytes?: number | null;
    signal?: AbortSignal;
    onProgress?: (bytes: number, totalBytes: number | null) => void;
}

export interface DeviceAudioReceipt {
    ref: DeviceAudioVaultRef;
    bytes: number;
    contentType: string | null;
    displayName: string;
    /** Remove only the just-retained file, even after an auth rotation. */
    discard(): Promise<void>;
}

export interface DeviceAudioInspectRequest {
    kind: "inspect";
    ref: DeviceAudioVaultRef;
    expectedBytes?: number | null;
}

export interface DeviceAudioPlayRequest {
    kind: "play";
    ref: DeviceAudioVaultRef;
    expectedBytes?: number | null;
}

export interface DeviceAudioRemoveRequest {
    kind: "remove";
    ref: DeviceAudioVaultRef;
}

export type DeviceAudioAccessRequest =
    | DeviceAudioInspectRequest
    | DeviceAudioPlayRequest
    | DeviceAudioRemoveRequest;

export interface DeviceAudioInspectResult {
    kind: "inspect";
    exists: boolean;
    bytes: number | null;
}

export interface DeviceAudioPlayResult {
    kind: "play";
    url: string;
    release(): void;
}

export interface DeviceAudioRemoveResult {
    kind: "remove";
    removed: boolean;
}

export type DeviceAudioAccessResult<T extends DeviceAudioAccessRequest> =
    T extends DeviceAudioInspectRequest
        ? DeviceAudioInspectResult
        : T extends DeviceAudioPlayRequest
          ? DeviceAudioPlayResult
          : DeviceAudioRemoveResult;

export interface DeviceAudioVaultSession {
    readonly ownerId: string;
    readonly authGeneration: number;
    readonly storage: {
        kind: "desktop-directory";
        label: string;
    };
    retain(input: DeviceAudioRetainInput): Promise<DeviceAudioReceipt>;
    access<T extends DeviceAudioAccessRequest>(
        input: T,
    ): Promise<DeviceAudioAccessResult<T>>;
}

/** Deep module interface for real device-file retention and playback. */
export interface DeviceAudioVault {
    inspectAccess(): Promise<DeviceAudioAccessState>;
    requestAccess(): Promise<DeviceAudioAccessState>;
    open(input: {
        ownerId: string;
        authGeneration: number;
    }): Promise<DeviceAudioVaultSession>;
}

export interface DeviceAudioWritable {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
}

export interface DeviceAudioFileHandle {
    readonly kind: "file";
    readonly name: string;
    createWritable(): Promise<DeviceAudioWritable>;
    getFile(): Promise<Blob>;
}

export interface DeviceAudioDirectoryHandle {
    readonly kind: "directory";
    readonly name: string;
    queryPermission(options?: { mode: "readwrite" }): Promise<PermissionState>;
    requestPermission(options?: {
        mode: "readwrite";
    }): Promise<PermissionState>;
    getDirectoryHandle(
        name: string,
        options?: { create?: boolean },
    ): Promise<DeviceAudioDirectoryHandle>;
    getFileHandle(
        name: string,
        options?: { create?: boolean },
    ): Promise<DeviceAudioFileHandle>;
    removeEntry(name: string): Promise<void>;
}

/** Handle persistence stays outside the platform adapter for testability. */
export interface DeviceAudioDirectoryRegistry {
    load(): Promise<DeviceAudioDirectoryHandle | null>;
    save(handle: DeviceAudioDirectoryHandle): Promise<void>;
}

/** Browser globals are injected so Node tests never require a real DOM. */
export interface DeviceAudioVaultRuntime {
    isSupported(): boolean;
    pickDirectory(): Promise<DeviceAudioDirectoryHandle>;
    createObjectUrl(file: Blob): string;
    revokeObjectUrl(url: string): void;
    createOpaqueId(): string;
    ownerScope(ownerId: string): Promise<string>;
    isAuthGenerationCurrent(generation: number): boolean;
}
