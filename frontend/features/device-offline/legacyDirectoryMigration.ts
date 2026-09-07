import type { DeviceOfflineDownloadRecord } from "./types";
import type {
    DeviceAudioExportResult,
    DeviceAudioReceipt,
    DeviceAudioVault,
} from "./vault";
import { frontendLogger } from "@/lib/logger";

const migrationLogger = frontendLogger.child("LegacyDirectoryMigration");

/** Owner-scoped, compare-and-swap publication for a verified private copy. */
export interface LegacyDirectoryMigrationInput {
    ownerId: string;
    authGeneration: number;
    records: DeviceOfflineDownloadRecord[];
    vault: DeviceAudioVault;
    signal: AbortSignal;
    now(): number;
    publish(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
    ): Promise<boolean>;
    read?(url: string, signal: AbortSignal): Promise<Response>;
}

/** Copy old public-folder audio into OPFS; never delete or change the original. */
export async function migrateLegacyDirectoryAudio(
    input: LegacyDirectoryMigrationInput,
): Promise<number> {
    const candidates = input.records.filter(
        (record) =>
            record.ownerId === input.ownerId &&
            record.status === "ready" &&
            String(record.mediaRef).startsWith("fsa1:"),
    );
    if (!candidates.length || !input.vault.inspectLegacyAccess) return 0;
    const destination = await input.vault.inspectAccess();
    if (
        destination.status !== "ready" ||
        destination.storageKind !== "browser-private"
    )
        return 0;
    if ((await input.vault.inspectLegacyAccess())?.status !== "ready") return 0;
    const session = await input.vault.open({
        ownerId: input.ownerId,
        authGeneration: input.authGeneration,
    });
    let migrated = 0;
    for (const record of candidates) {
        input.signal.throwIfAborted();
        let source: DeviceAudioExportResult | null = null;
        let receipt: DeviceAudioReceipt | null = null;
        let response: Response | null = null;
        try {
            source = await session.access({
                kind: "export",
                ref: record.mediaRef!,
                expectedBytes: record.totalBytes,
            });
            if (!source.url.startsWith("blob:"))
                throw new Error("Expected local device file");
            response = await (
                input.read ?? ((url, signal) => fetch(url, { signal }))
            )(source.url, input.signal);
            if (!response.ok || !response.body)
                throw new Error("Local device file unavailable");
            receipt = await session.retain({
                track: record.track,
                quality: record.quality,
                stream: response.body,
                contentType:
                    record.contentType ?? response.headers.get("content-type"),
                expectedBytes: record.totalBytes,
                signal: input.signal,
            });
            input.signal.throwIfAborted();
            if (
                await input.publish(record, {
                    ...record,
                    mediaRef: receipt.ref,
                    bytesReceived: receipt.bytes,
                    totalBytes: receipt.bytes,
                    contentType: receipt.contentType,
                    persistenceGranted: receipt.persistenceGranted ?? null,
                    integrityVersion: 1,
                    updatedAt: input.now(),
                })
            ) {
                receipt = null;
                migrated++;
            }
        } catch (error) {
            if (input.signal.aborted) throw error;
            // Keep this record and its original file recoverable; another
            // valid track must not be blocked by a missing or damaged file.
            migrationLogger.warn(
                "A legacy device file could not be copied; its original reference is preserved",
            );
        } finally {
            if (receipt)
                await receipt
                    .discard()
                    .catch(() =>
                        migrationLogger.warn(
                            "Unpublished private copy cleanup failed",
                        ),
                    );
            if (response?.body && !response.body.locked)
                await response.body
                    .cancel()
                    .catch(() =>
                        migrationLogger.warn(
                            "Local copy stream cleanup failed",
                        ),
                    );
            source?.release();
        }
    }
    return migrated;
}
