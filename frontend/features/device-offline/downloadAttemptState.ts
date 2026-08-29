import type { DeviceOfflineDownloadRecord } from "./types";

interface DeviceOfflineProgressDependencies {
    metadataStore: {
        getByKey(key: string): Promise<DeviceOfflineDownloadRecord | null>;
        putIfCurrent(
            expected: DeviceOfflineDownloadRecord,
            next: DeviceOfflineDownloadRecord,
            isAuthorized?: () => boolean,
        ): Promise<boolean>;
    };
    now(): number;
}

/** True only while the exact foreground attempt may still publish progress/ready. */
export function isCurrentForegroundAttempt(
    current: DeviceOfflineDownloadRecord | null,
    expected: DeviceOfflineDownloadRecord,
): current is DeviceOfflineDownloadRecord {
    return (
        current?.key === expected.key &&
        current.ownerId === expected.ownerId &&
        current.attempt === expected.attempt &&
        current.status === "downloading" &&
        current.transferMode === "foreground" &&
        (current.foregroundLeaseId ?? null) ===
            (expected.foregroundLeaseId ?? null)
    );
}

export function backgroundLeaseRetry(leaseId: string, prefix: string): number {
    if (!leaseId.startsWith(prefix)) return 0;
    const retry = Number(leaseId.slice(prefix.length).split(":", 1)[0]);
    return Number.isSafeInteger(retry) && retry > 0 ? retry : 0;
}

/** Publish monotonic foreground progress for the exact active attempt. */
export async function publishDeviceOfflineProgress(
    dependencies: DeviceOfflineProgressDependencies,
    expected: DeviceOfflineDownloadRecord,
    bytesReceived: number,
    totalBytes: number | null,
    leaseTtlMs: number,
    isAuthorized?: () => boolean,
): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await dependencies.metadataStore.getByKey(expected.key);
        if (!isCurrentForegroundAttempt(current, expected)) return false;
        if (bytesReceived <= current.bytesReceived) return false;
        const now = dependencies.now();
        const progress: DeviceOfflineDownloadRecord = {
            ...current,
            bytesReceived,
            totalBytes,
            foregroundLeaseExpiresAt: now + leaseTtlMs,
            updatedAt: now,
        };
        if (
            await dependencies.metadataStore.putIfCurrent(
                current,
                progress,
                isAuthorized,
            )
        ) {
            return true;
        }
    }
    return false;
}
