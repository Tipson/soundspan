import type { DeviceOfflineDownloadRecord } from "./types";
import type { DeviceAudioVault } from "./vault";
import { removeDeviceAudioRecord } from "./vaultRecordAccess";

interface DeleteDeviceAudioRecordTransactionInput {
    expected: DeviceOfflineDownloadRecord;
    vault: DeviceAudioVault;
    authGeneration: number;
    now(): number;
    claim(
        expected: DeviceOfflineDownloadRecord,
        deleting: DeviceOfflineDownloadRecord,
    ): Promise<boolean>;
    publishFailure(
        deleting: DeviceOfflineDownloadRecord,
        failed: DeviceOfflineDownloadRecord,
    ): Promise<boolean>;
    finalize(deleting: DeviceOfflineDownloadRecord): Promise<boolean>;
}

/**
 * Keep a retryable metadata tombstone until the exact real file is gone.
 * Cross-store deletion cannot be atomic, so metadata must never disappear first.
 */
export async function deleteDeviceAudioRecordTransaction(
    input: DeleteDeviceAudioRecordTransactionInput,
): Promise<boolean> {
    const deleting: DeviceOfflineDownloadRecord = {
        ...input.expected,
        status: "error",
        backgroundFetchId: null,
        foregroundLeaseId: null,
        foregroundLeaseExpiresAt: null,
        errorCode: "device_file_delete_pending",
        errorMessage:
            "Removing this device file was interrupted. Delete it again to retry.",
        updatedAt: input.now(),
    };
    if (!(await input.claim(input.expected, deleting))) return false;

    try {
        await removeDeviceAudioRecord(
            input.vault,
            deleting,
            input.authGeneration,
        );
    } catch (error) {
        const failed: DeviceOfflineDownloadRecord = {
            ...deleting,
            errorCode: "device_file_delete_failed",
            errorMessage:
                "Soundspan could not remove this device file. Restore folder access and delete it again.",
            updatedAt: input.now(),
        };
        await input.publishFailure(deleting, failed).catch(() => false);
        throw error;
    }

    return input.finalize(deleting);
}
