import type { DeviceOfflineTrack } from "./types";

/** Normalize the quality dimension used by the IndexedDB uniqueness key. */
export function normalizeDeviceOfflineQuality(
    quality: string | null | undefined,
): string {
    const normalized = String(quality ?? "auto")
        .trim()
        .toLowerCase();
    return normalized || "auto";
}

/** Resolve a provider-stable identity without embedding user credentials. */
export function resolveDeviceOfflineTrackIdentity(
    track: Pick<
        DeviceOfflineTrack,
        "id" | "streamSource" | "tidalTrackId" | "youtubeVideoId"
    >,
): string {
    if (track.tidalTrackId && track.tidalTrackId > 0) {
        return `tidal:${track.tidalTrackId}`;
    }
    if (track.youtubeVideoId) {
        return `youtube:${track.youtubeVideoId}`;
    }
    return `track:${track.id}`;
}

/** Build the service-worker-owned stable media URL for an opaque cache key. */
export function buildDeviceOfflineVirtualUrl(key: string): string {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
        throw new Error("Некорректный ключ офлайн-кэша устройства");
    }
    return `/__offline/audio/${key}`;
}
