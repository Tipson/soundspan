import type {
    DeviceOfflineDownloadRecord,
    DeviceOfflineManagement,
} from "./types";
import type { DeviceAudioVault } from "./vault";
import { deleteDeviceAudioRecordTransaction } from "./vaultRecordDeletion";

interface DeviceOfflineRecordManagementStore {
    getByKey(key: string): Promise<DeviceOfflineDownloadRecord | null>;
    putIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    putAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    deleteIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
    deleteAutoManagedIfCurrent(
        expected: DeviceOfflineDownloadRecord,
        isAuthorized?: () => boolean,
    ): Promise<boolean>;
}

interface DeviceOfflineRecordManagementDependencies {
    metadataStore: DeviceOfflineRecordManagementStore;
    audioCache: {
        delete(url: string): Promise<void>;
    };
    audioVault?: DeviceAudioVault;
    abortBackgroundFetch(record: DeviceOfflineDownloadRecord): Promise<unknown>;
    origin: string;
    now(): number;
}

interface DeviceOfflineRecordAuthorization {
    authGeneration: number;
    isAuthorized(): boolean;
}

/** Remove one exact copy while preserving retryable real-file tombstones. */
export async function deleteManagedDeviceOfflineRecord(
    dependencies: DeviceOfflineRecordManagementDependencies,
    expected: DeviceOfflineDownloadRecord,
    authorization: DeviceOfflineRecordAuthorization,
    autoManagedOnly: boolean,
): Promise<boolean> {
    await dependencies.abortBackgroundFetch(expected).catch(() => undefined);
    if (expected.mediaRef && dependencies.audioVault) {
        return deleteDeviceAudioRecordTransaction({
            expected,
            vault: dependencies.audioVault,
            authGeneration: authorization.authGeneration,
            now: dependencies.now,
            claim: (record, deleting) =>
                autoManagedOnly
                    ? dependencies.metadataStore.putAutoManagedIfCurrent(
                          record,
                          deleting,
                          authorization.isAuthorized,
                      )
                    : dependencies.metadataStore.putIfCurrent(
                          record,
                          deleting,
                          authorization.isAuthorized,
                      ),
            publishFailure: (deleting, failed) =>
                dependencies.metadataStore.putIfCurrent(
                    deleting,
                    failed,
                    authorization.isAuthorized,
                ),
            finalize: (deleting) =>
                dependencies.metadataStore.deleteIfCurrent(
                    deleting,
                    authorization.isAuthorized,
                ),
        });
    }

    const deleted = autoManagedOnly
        ? await dependencies.metadataStore.deleteAutoManagedIfCurrent(
              expected,
              authorization.isAuthorized,
          )
        : await dependencies.metadataStore.deleteIfCurrent(
              expected,
              authorization.isAuthorized,
          );
    if (!deleted) return false;
    await dependencies.audioCache.delete(
        new URL(expected.virtualUrl, dependencies.origin).toString(),
    );
    return true;
}

interface PromoteDeviceOfflineRecordInput {
    ownerId: string;
    key: string;
    isAuthorized(): boolean;
    assertAuthorized(): void;
}

interface ReuseReadyDeviceOfflineRecordInput {
    ownerId: string;
    previous: DeviceOfflineDownloadRecord | null;
    trackIdentity: string;
    quality: string;
    requestedManagement: DeviceOfflineManagement;
    isAuthorized(): boolean;
    assertAuthorized(): void;
    notifyChanged(): void;
}

interface ReuseReadyDeviceOfflineRecordResult {
    record: DeviceOfflineDownloadRecord | null;
    management: DeviceOfflineManagement;
}

/** Promote only a complete auto-managed copy; tombstones remain retryable. */
export async function promoteReadyDeviceOfflineRecord(
    dependencies: DeviceOfflineRecordManagementDependencies,
    input: PromoteDeviceOfflineRecordInput,
): Promise<{
    record: DeviceOfflineDownloadRecord | null;
    changed: boolean;
}> {
    input.assertAuthorized();
    const record = await dependencies.metadataStore.getByKey(input.key);
    input.assertAuthorized();
    if (!record || record.ownerId !== input.ownerId) {
        return { record: null, changed: false };
    }
    if (record.status !== "ready" || record.management !== "auto-liked") {
        return { record, changed: false };
    }

    const promoted: DeviceOfflineDownloadRecord = {
        ...record,
        management: "manual",
        updatedAt: dependencies.now(),
    };
    if (
        await dependencies.metadataStore.putIfCurrent(
            record,
            promoted,
            input.isAuthorized,
        )
    ) {
        return { record: promoted, changed: true };
    }

    const current = await dependencies.metadataStore.getByKey(input.key);
    return {
        record: current?.ownerId === input.ownerId ? current : null,
        changed: false,
    };
}

/** Reuse one complete copy and atomically protect it after a manual action. */
export async function reuseReadyDeviceOfflineRecord(
    dependencies: DeviceOfflineRecordManagementDependencies,
    input: ReuseReadyDeviceOfflineRecordInput,
): Promise<ReuseReadyDeviceOfflineRecordResult> {
    const previousManagement = input.previous
        ? input.previous.management === "auto-liked"
            ? "auto-liked"
            : "manual"
        : input.requestedManagement;
    const management =
        input.requestedManagement === "manual" ||
        previousManagement === "manual"
            ? "manual"
            : "auto-liked";
    if (input.previous?.status !== "ready") {
        return { record: null, management };
    }

    const promotePrevious = () =>
        promoteReadyDeviceOfflineRecord(dependencies, {
            ownerId: input.ownerId,
            key: input.previous!.key,
            isAuthorized: input.isAuthorized,
            assertAuthorized: input.assertAuthorized,
        });
    let current: DeviceOfflineDownloadRecord | null;
    if (
        input.requestedManagement === "manual" &&
        input.previous.management === "auto-liked"
    ) {
        const promotion = await promotePrevious();
        if (promotion.changed) input.notifyChanged();
        current = promotion.record;
    } else {
        current = await dependencies.metadataStore.getByKey(input.previous.key);
    }
    input.assertAuthorized();

    if (
        input.requestedManagement === "manual" &&
        current?.status === "ready" &&
        current.management === "auto-liked"
    ) {
        const promotion = await promotePrevious();
        if (promotion.changed) input.notifyChanged();
        current = promotion.record;
        input.assertAuthorized();
    }

    const reusable =
        current?.ownerId === input.ownerId &&
        current.status === "ready" &&
        current.trackIdentity === input.trackIdentity &&
        current.quality === input.quality
            ? current
            : null;
    return { record: reusable, management };
}
