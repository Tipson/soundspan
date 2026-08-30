import { DeviceAudioVaultError } from "./vault";

/** Stable manager-level failure surfaced through download metadata. */
export class DeviceOfflineDownloadError extends Error {
    constructor(
        readonly code: "http" | "quota" | "cache" | "invalid_source",
        message: string,
        readonly httpStatus?: number,
    ) {
        super(message);
        this.name = "DeviceOfflineDownloadError";
    }
}

export class StaleDeviceOfflineAttemptError extends Error {
    constructor() {
        super("Device download was superseded or deleted");
        this.name = "StaleDeviceOfflineAttemptError";
    }
}

export class SupersededDeviceOfflineAuthRuntimeError extends Error {
    constructor() {
        super("Authentication session changed while the download was pending");
        this.name = "SupersededDeviceOfflineAuthRuntimeError";
    }
}

export function classifyDeviceOfflineFailure(error: unknown): {
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
    if (error instanceof DeviceAudioVaultError) {
        return {
            status: error.code === "interrupted" ? "interrupted" : "error",
            code:
                error.code === "storage_full"
                    ? "quota"
                    : `device_file_${error.code}`,
            message,
        };
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
