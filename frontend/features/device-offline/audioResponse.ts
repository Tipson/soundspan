import { DeviceOfflineDownloadError } from "./downloadError";

/** Parse a trustworthy complete-response byte length, if the server supplied one. */
export function parseDeviceAudioContentLength(
    response: Response,
): number | null {
    const raw = response.headers.get("content-length");
    if (raw === null || raw.trim() === "") return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Preserve only replay-relevant headers in the legacy CacheStorage response. */
export function createLegacyCachedAudioResponse(
    response: Response,
    body: BodyInit | null,
    totalBytes: number | null,
): Response {
    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    if (totalBytes !== null) {
        headers.set("content-length", String(totalBytes));
    }
    headers.set("accept-ranges", "bytes");
    const etag = response.headers.get("etag");
    if (etag) headers.set("etag", etag);
    const lastModified = response.headers.get("last-modified");
    if (lastModified) headers.set("last-modified", lastModified);
    return new Response(body, { status: 200, headers });
}

/** Verify one legacy CacheStorage body before exposing it to playback. */
export async function verifyLegacyCachedAudioBytes(
    response: Response,
    expectedBytes: number | null,
): Promise<number> {
    const actualBytes = (await response.clone().arrayBuffer()).byteLength;
    if (actualBytes < 1) {
        throw new DeviceOfflineDownloadError(
            "cache",
            "Браузер сохранил пустой аудиофайл",
        );
    }
    if (expectedBytes !== null && actualBytes !== expectedBytes) {
        throw new DeviceOfflineDownloadError(
            "cache",
            `Сохранённый аудиофайл неполный (${actualBytes} из ${expectedBytes} байт)`,
        );
    }
    return actualBytes;
}

/** CacheStorage-only quota preflight; real folders report capacity while writing. */
export async function assertLegacyCacheQuotaAvailable(
    estimateStorage: () => Promise<{
        usage?: number;
        quota?: number;
    } | null>,
    totalBytes: number | null,
): Promise<void> {
    if (totalBytes === null || totalBytes === 0) return;
    const estimate = await estimateStorage();
    if (!estimate) return;
    const quota = Number(estimate.quota);
    const usage = Number(estimate.usage);
    if (!Number.isFinite(quota) || !Number.isFinite(usage)) return;
    if (Math.max(0, quota - usage) < totalBytes) {
        throw new DeviceOfflineDownloadError(
            "quota",
            "На устройстве недостаточно места для этого трека",
        );
    }
}
