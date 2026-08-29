import {
    normalizeDeviceOfflineQuality,
    resolveDeviceOfflineTrackIdentity,
} from "./trackIdentity";
import type { DeviceOfflineDownloadRecord, DeviceOfflineTrack } from "./types";

let activeOwnerId: string | null = null;
let readyRecords: DeviceOfflineDownloadRecord[] = [];
const MAX_PREPARED_DEVICE_OFFLINE_SOURCES = 2;
const preparedSources = new Map<
    string,
    { ownerId: string; url: string; revoke: () => void }
>();

/** User-facing terminal copy for an offline playback failure. */
export function getDeviceOfflinePlaybackErrorMessage(
    hasDeviceCopy: boolean,
): string {
    return hasDeviceCopy
        ? "This downloaded copy could not be opened. Download it again when you are online."
        : "You are offline and this track is not downloaded to this device.";
}

function releasePreparedSource(key: string): void {
    const prepared = preparedSources.get(key);
    if (!prepared) return;
    preparedSources.delete(key);
    prepared.revoke();
}

function releaseStalePreparedSources(
    ownerId: string,
    records: DeviceOfflineDownloadRecord[],
): void {
    const retainedKeys = new Set(
        records
            .filter(
                (record) =>
                    record.ownerId === ownerId && record.status === "ready",
            )
            .map((record) => record.key),
    );
    for (const [key, prepared] of preparedSources) {
        if (prepared.ownerId !== ownerId || !retainedKeys.has(key)) {
            releasePreparedSource(key);
        }
    }
}

/** Replace the in-memory, already-verified playback index for the active user. */
export function setDeviceOfflineRuntimeState(
    ownerId: string,
    records: DeviceOfflineDownloadRecord[],
): void {
    releaseStalePreparedSources(ownerId, records);
    activeOwnerId = ownerId;
    readyRecords = records.filter(
        (record) => record.ownerId === ownerId && record.status === "ready",
    );
}

/** Remove all user-bound device playback capabilities from memory. */
export function clearDeviceOfflineRuntimeState(): void {
    for (const key of [...preparedSources.keys()]) {
        releasePreparedSource(key);
    }
    activeOwnerId = null;
    readyRecords = [];
}

/** Check whether the active owner already has a live local playback URL. */
export function hasPreparedDeviceOfflinePlaybackSource(
    ownerId: string,
    key: string,
): boolean {
    return (
        activeOwnerId === ownerId &&
        preparedSources.get(key)?.ownerId === ownerId
    );
}

/** Register a short-lived local Blob URL after CacheStorage verification. */
export function prepareDeviceOfflinePlaybackSource(
    ownerId: string,
    record: DeviceOfflineDownloadRecord,
    url: string,
    revoke: () => void,
): boolean {
    const isCurrentReadyRecord =
        activeOwnerId === ownerId &&
        record.ownerId === ownerId &&
        record.status === "ready" &&
        readyRecords.some(
            (candidate) =>
                candidate.key === record.key &&
                candidate.ownerId === ownerId &&
                candidate.status === "ready",
        );
    if (!isCurrentReadyRecord) {
        revoke();
        return false;
    }

    const previous = preparedSources.get(record.key);
    if (previous?.url === url) {
        revoke();
        return true;
    }
    if (previous) releasePreparedSource(record.key);
    while (preparedSources.size >= MAX_PREPARED_DEVICE_OFFLINE_SOURCES) {
        const oldestKey = preparedSources.keys().next().value as
            | string
            | undefined;
        if (!oldestKey) break;
        releasePreparedSource(oldestKey);
    }
    preparedSources.set(record.key, { ownerId, url, revoke });
    return true;
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
    const selected = preferred ?? candidates[0];
    if (!selected) return networkUrl;
    return preparedSources.get(selected.key)?.url ?? selected.virtualUrl;
}
