import {
    normalizeDeviceOfflineQuality,
    resolveDeviceOfflineTrackIdentity,
} from "./trackIdentity";
import type { DeviceOfflineDownloadRecord, DeviceOfflineTrack } from "./types";

let activeOwnerId: string | null = null;
let readyRecords: DeviceOfflineDownloadRecord[] = [];

/** Replace the in-memory, already-verified playback index for the active user. */
export function setDeviceOfflineRuntimeState(
    ownerId: string,
    records: DeviceOfflineDownloadRecord[],
): void {
    activeOwnerId = ownerId;
    readyRecords = records.filter(
        (record) => record.ownerId === ownerId && record.status === "ready",
    );
}

/** Remove all user-bound device playback capabilities from memory. */
export function clearDeviceOfflineRuntimeState(): void {
    activeOwnerId = null;
    readyRecords = [];
}

/** Prefer a ready device copy, falling back to the supplied clean network URL. */
export function resolveDeviceOfflinePlaybackUrl(
    track: Pick<
        DeviceOfflineTrack,
        "id" | "streamSource" | "tidalTrackId" | "youtubeVideoId"
    >,
    networkUrl: string,
    preferredQuality: string = "auto",
): string {
    if (!activeOwnerId) return networkUrl;

    const identity = resolveDeviceOfflineTrackIdentity(track);
    const quality = normalizeDeviceOfflineQuality(preferredQuality);
    const candidates = readyRecords
        .filter(
            (record) =>
                record.ownerId === activeOwnerId &&
                record.trackIdentity === identity,
        )
        .sort((left, right) => right.updatedAt - left.updatedAt);
    const preferred = candidates.find(
        (candidate) => candidate.quality === quality,
    );
    return preferred?.virtualUrl ?? candidates[0]?.virtualUrl ?? networkUrl;
}
