import type { DeviceOfflineDownloadRecord } from "./types";
import type { DeviceAudioVault, DeviceAudioVaultSession } from "./vault";

interface LegacyAudioCache {
    match(url: string): Promise<Response | null>;
    delete(url: string): Promise<void>;
}

export interface LegacyCacheMigrationInput {
    ownerId: string;
    authGeneration: number;
    records: DeviceOfflineDownloadRecord[];
    vault: DeviceAudioVault;
    audioCache: LegacyAudioCache;
    origin: string;
    signal: AbortSignal;
    now(): number;
    publish(
        expected: DeviceOfflineDownloadRecord,
        next: DeviceOfflineDownloadRecord,
    ): Promise<boolean>;
}

/** Move verified legacy bytes before switching metadata and deleting CacheStorage. */
export async function migrateLegacyDeviceAudioCache(
    input: LegacyCacheMigrationInput,
): Promise<number> {
    const candidates = input.records.filter(
        (record) =>
            record.ownerId === input.ownerId && record.status === "ready",
    );
    if (candidates.length === 0) return 0;
    let session: DeviceAudioVaultSession | null = null;
    let migrated = 0;
    for (const record of candidates) {
        if (input.signal.aborted)
            throw new DOMException("Migration aborted", "AbortError");
        const cacheUrl = new URL(record.virtualUrl, input.origin).toString();
        if (record.mediaRef) {
            if (await input.audioCache.match(cacheUrl)) {
                await input.audioCache.delete(cacheUrl);
            }
            continue;
        }
        const cached = await input.audioCache.match(cacheUrl);
        if (!cached) continue;
        session ??= await input.vault.open({
            ownerId: input.ownerId,
            authGeneration: input.authGeneration,
        });
        let receipt: Awaited<
            ReturnType<DeviceAudioVaultSession["retain"]>
        > | null = null;
        try {
            const stream =
                cached.body ??
                new Blob([await cached.arrayBuffer()], {
                    type: record.contentType ?? undefined,
                }).stream();
            receipt = await session.retain({
                track: record.track,
                quality: record.quality,
                stream,
                contentType:
                    record.contentType ?? cached.headers.get("content-type"),
                expectedBytes: record.totalBytes,
                signal: input.signal,
            });
            const next: DeviceOfflineDownloadRecord = {
                ...record,
                mediaRef: receipt.ref,
                bytesReceived: receipt.bytes,
                totalBytes: receipt.bytes,
                integrityVersion: 1,
                contentType: receipt.contentType,
                updatedAt: input.now(),
            };
            if (!(await input.publish(record, next))) {
                await receipt.discard().catch(() => undefined);
                continue;
            }
            receipt = null;
            migrated += 1;
        } catch (error) {
            if (receipt) {
                await receipt.discard().catch(() => undefined);
            }
            if (input.signal.aborted) throw error;
            continue;
        }
        // Metadata now points at the ordinary device file. Cleanup failure must
        // remain observable so a later migration pass retries this exact cache
        // entry without retaining another copy.
        await input.audioCache.delete(cacheUrl);
    }
    return migrated;
}
