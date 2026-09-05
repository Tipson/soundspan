import type { DeviceOfflineDownloadRecord, DeviceOfflineTrack } from "./types";

type DeviceOfflineIdentityTrack = Pick<
    DeviceOfflineTrack,
    | "id"
    | "filePath"
    | "source"
    | "streamSource"
    | "tidalTrackId"
    | "youtubeVideoId"
>;

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
    track: DeviceOfflineIdentityTrack,
): string {
    const source = track.streamSource ?? track.source;
    if (track.filePath || source === "local") {
        return `track:${track.id}`;
    }
    if (
        (source === "youtube" || source === "youtube-direct") &&
        track.youtubeVideoId
    ) {
        return `youtube:${track.youtubeVideoId}`;
    }
    if (source === "tidal" && track.tidalTrackId && track.tidalTrackId > 0) {
        return `tidal:${track.tidalTrackId}`;
    }
    if (track.tidalTrackId && track.tidalTrackId > 0) {
        return `tidal:${track.tidalTrackId}`;
    }
    if (track.youtubeVideoId) {
        return `youtube:${track.youtubeVideoId}`;
    }
    return `track:${track.id}`;
}

function decodeRouteIdentity(
    sourceUrl: string,
    pattern: RegExp,
): string | null {
    if (!sourceUrl.startsWith("/") || sourceUrl.startsWith("//")) return null;
    let parsed: URL;
    try {
        parsed = new URL(sourceUrl, "https://soundspan.invalid");
    } catch {
        return null;
    }
    if (
        parsed.origin !== "https://soundspan.invalid" ||
        parsed.username ||
        parsed.password
    ) {
        return null;
    }
    const match = pattern.exec(parsed.pathname);
    if (!match?.[1]) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return null;
    }
}

function hasMatchingLegacyProviderKey(
    record: DeviceOfflineDownloadRecord,
): boolean {
    if (
        typeof record.trackIdentity !== "string" ||
        !record.track ||
        typeof record.sourceUrl !== "string"
    ) {
        return false;
    }
    if (record.trackIdentity.startsWith("tidal:")) {
        const id = Number(record.trackIdentity.slice("tidal:".length));
        return (
            Number.isSafeInteger(id) &&
            id > 0 &&
            record.track.tidalTrackId === id
        );
    }
    if (record.trackIdentity.startsWith("youtube:")) {
        const id = record.trackIdentity.slice("youtube:".length);
        return Boolean(id) && record.track.youtubeVideoId === id;
    }
    return false;
}

/**
 * Resolve a current identity for a legacy provider-keyed record only when its
 * retained source route proves that the bytes belong to that same local or
 * YouTube asset. The record itself remains immutable.
 */
export function resolveCompatibleDeviceOfflineRecordIdentity(
    record: DeviceOfflineDownloadRecord,
): string | null {
    if (!hasMatchingLegacyProviderKey(record)) return null;

    const localTrackId = decodeRouteIdentity(
        record.sourceUrl,
        /^\/api\/library\/tracks\/([^/]+)\/stream\/?$/,
    );
    if (
        localTrackId === record.track.id &&
        (Boolean(record.track.filePath) ||
            record.track.source === "local" ||
            record.track.streamSource === "local")
    ) {
        return `track:${record.track.id}`;
    }

    const youtubeVideoId = decodeRouteIdentity(
        record.sourceUrl,
        /^\/api\/(?:ytmusic\/(?:stream|stream-public)|youtube\/stream)\/([^/]+)\/?$/,
    );
    if (
        youtubeVideoId === record.track.youtubeVideoId &&
        (record.track.streamSource === "youtube" ||
            record.track.streamSource === "youtube-direct" ||
            record.track.source === "youtube")
    ) {
        return `youtube:${record.track.youtubeVideoId}`;
    }

    return null;
}

/** Match current actionable identity to an exact or provenance-verified record. */
export function deviceOfflineRecordMatchesTrack(
    record: DeviceOfflineDownloadRecord,
    track: DeviceOfflineIdentityTrack,
): boolean {
    const identity = resolveDeviceOfflineTrackIdentity(track);
    if (identity.startsWith("tidal:")) return false;
    return (
        record.trackIdentity === identity ||
        resolveCompatibleDeviceOfflineRecordIdentity(record) === identity
    );
}

/** Build the service-worker-owned stable media URL for an opaque cache key. */
export function buildDeviceOfflineVirtualUrl(key: string): string {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
        throw new Error("Некорректный ключ офлайн-кэша устройства");
    }
    return `/__offline/audio/${key}`;
}
