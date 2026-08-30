import { parseDeviceAudioContentLength } from "./audioResponse";
import { DeviceOfflineDownloadError } from "./downloadError";
import type { DeviceOfflineDownloadRecord, DeviceOfflineTrack } from "./types";
import type { DeviceAudioReceipt, DeviceAudioVault } from "./vault";

export interface RetainDeviceAudioFileInput {
    vault: DeviceAudioVault;
    ownerId: string;
    authGeneration: number;
    track: DeviceOfflineTrack;
    quality: string;
    sourceUrl: string;
    signal: AbortSignal;
    request: (
        input: RequestInfo | URL,
        init?: RequestInit,
    ) => Promise<Response>;
    onHeaders(input: {
        totalBytes: number | null;
        contentType: string | null;
    }): Promise<void>;
    onProgress(bytes: number, totalBytes: number | null): Promise<void>;
}

export interface RetainedDeviceAudioFile {
    receipt: DeviceAudioReceipt;
}

export interface CompleteDeviceAudioDownloadInput {
    vault: DeviceAudioVault;
    record: DeviceOfflineDownloadRecord;
    authGeneration: number;
    sourceUrl: string;
    signal: AbortSignal;
    request: RetainDeviceAudioFileInput["request"];
    now(): number;
    assertCurrent(): void;
    onHeaders(
        expected: DeviceOfflineDownloadRecord,
        headers: { totalBytes: number | null; contentType: string | null },
    ): Promise<DeviceOfflineDownloadRecord>;
    onProgress(
        expected: DeviceOfflineDownloadRecord,
        bytes: number,
        totalBytes: number | null,
    ): Promise<void>;
    validateCurrent(expected: DeviceOfflineDownloadRecord): Promise<void>;
    publishReady(
        expected: DeviceOfflineDownloadRecord,
        ready: DeviceOfflineDownloadRecord,
    ): Promise<void>;
}

/** Stream one authenticated response into the selected real device folder. */
export async function retainDeviceAudioFile(
    input: RetainDeviceAudioFileInput,
): Promise<RetainedDeviceAudioFile> {
    const session = await input.vault.open({
        ownerId: input.ownerId,
        authGeneration: input.authGeneration,
    });
    const response = await input.request(input.sourceUrl, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        signal: input.signal,
    });
    if (response.status !== 200) {
        throw new DeviceOfflineDownloadError(
            "http",
            `Audio download failed with HTTP ${response.status}`,
        );
    }

    const totalBytes = parseDeviceAudioContentLength(response);
    const contentType = response.headers.get("content-type");
    await input.onHeaders({ totalBytes, contentType });
    const stream =
        response.body ??
        new Blob([await response.arrayBuffer()], {
            type: contentType ?? undefined,
        }).stream();
    let progress = Promise.resolve();
    let receipt: DeviceAudioReceipt | null = null;
    try {
        receipt = await session.retain({
            track: input.track,
            quality: input.quality,
            stream,
            contentType,
            expectedBytes: totalBytes,
            signal: input.signal,
            onProgress: (bytes, expectedBytes) => {
                progress = progress.then(() =>
                    input.onProgress(bytes, expectedBytes),
                );
            },
        });
        await progress;
        return { receipt };
    } catch (error) {
        await progress.catch(() => undefined);
        if (receipt) {
            await receipt.discard().catch(() => undefined);
        }
        throw error;
    }
}

/** Complete the manager transaction and roll back a retained file on stale metadata. */
export async function completeDeviceAudioDownload(
    input: CompleteDeviceAudioDownloadInput,
): Promise<DeviceOfflineDownloadRecord> {
    let record = input.record;
    let retained: RetainedDeviceAudioFile | null = null;
    try {
        retained = await retainDeviceAudioFile({
            vault: input.vault,
            ownerId: record.ownerId,
            authGeneration: input.authGeneration,
            track: record.track,
            quality: record.quality,
            sourceUrl: input.sourceUrl,
            signal: input.signal,
            request: input.request,
            onHeaders: async (headers) => {
                record = await input.onHeaders(record, headers);
            },
            onProgress: (bytes, totalBytes) =>
                input.onProgress(record, bytes, totalBytes),
        });
        input.assertCurrent();
        await input.validateCurrent(record);
        const ready: DeviceOfflineDownloadRecord = {
            ...record,
            mediaRef: retained.receipt.ref,
            status: "ready",
            foregroundLeaseId: null,
            foregroundLeaseExpiresAt: null,
            bytesReceived: retained.receipt.bytes,
            totalBytes: retained.receipt.bytes,
            integrityVersion: 1,
            contentType: retained.receipt.contentType,
            persistenceGranted:
                retained.receipt.persistenceGranted ??
                record.persistenceGranted,
            errorCode: null,
            errorMessage: null,
            updatedAt: input.now(),
        };
        await input.publishReady(record, ready);
        input.assertCurrent();
        retained = null;
        return ready;
    } catch (error) {
        if (retained) {
            await retained.receipt.discard().catch(() => undefined);
        }
        throw error;
    }
}
