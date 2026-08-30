import type { DeviceOfflineDownloadRecord } from "./types";
import { DeviceAudioVaultError, type DeviceAudioVault } from "./vault";

export type DeviceAudioRecordInspection =
    | { status: "available"; bytes: number }
    | { status: "missing" }
    | { status: "integrity"; message: string }
    | { status: "unavailable" };

export function reconcileDeviceAudioRecord(
    record: DeviceOfflineDownloadRecord,
    inspection: DeviceAudioRecordInspection,
    now: number,
): DeviceOfflineDownloadRecord | null {
    if (inspection.status === "missing") {
        return {
            ...record,
            status: "interrupted",
            errorCode: "device_file_missing",
            errorMessage:
                "Файл на устройстве отсутствует. Возобновите загрузку, чтобы скачать его снова.",
            updatedAt: now,
        };
    }
    if (inspection.status === "integrity") {
        return {
            ...record,
            status: "interrupted",
            errorCode: "device_file_integrity",
            errorMessage: inspection.message,
            updatedAt: now,
        };
    }
    if (
        inspection.status === "available" &&
        (record.bytesReceived !== inspection.bytes ||
            record.totalBytes !== inspection.bytes)
    ) {
        return {
            ...record,
            bytesReceived: inspection.bytes,
            totalBytes: inspection.bytes,
            integrityVersion: 1,
        };
    }
    return null;
}

/** Inspect without prompting; permission/setup failures remain recoverable UI state. */
export async function inspectDeviceAudioRecord(
    vault: DeviceAudioVault,
    record: DeviceOfflineDownloadRecord,
    authGeneration: number,
): Promise<DeviceAudioRecordInspection> {
    if (!record.mediaRef) return { status: "missing" };
    try {
        const session = await vault.open({
            ownerId: record.ownerId,
            authGeneration,
        });
        const result = await session.access({
            kind: "inspect",
            ref: record.mediaRef,
            expectedBytes: record.totalBytes,
        });
        return result.exists && typeof result.bytes === "number"
            ? { status: "available", bytes: result.bytes }
            : { status: "missing" };
    } catch (error) {
        if (
            error instanceof DeviceAudioVaultError &&
            error.code === "integrity"
        ) {
            return { status: "integrity", message: error.message };
        }
        return { status: "unavailable" };
    }
}

/** Remove the real file referenced by an exact metadata record. */
export async function removeDeviceAudioRecord(
    vault: DeviceAudioVault,
    record: DeviceOfflineDownloadRecord,
    authGeneration: number,
): Promise<boolean> {
    if (!record.mediaRef) return false;
    const session = await vault.open({
        ownerId: record.ownerId,
        authGeneration,
    });
    const result = await session.access({
        kind: "remove",
        ref: record.mediaRef,
    });
    return result.removed;
}
