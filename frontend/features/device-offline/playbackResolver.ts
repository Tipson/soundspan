import {
    normalizeDeviceOfflineQuality,
    resolveDeviceOfflineTrackIdentity,
} from "./trackIdentity";
import type { DeviceOfflineDownloadRecord, DeviceOfflineTrack } from "./types";
import { getAuthRuntimeLease } from "@/lib/auth-runtime-generation";
import {
    DeviceAudioVaultError,
    getDeviceAudioVault,
    type DeviceAudioPlayResult,
} from "./vault";

let activeOwnerId: string | null = null;
let readyRecords: DeviceOfflineDownloadRecord[] = [];
const MAX_PREPARED_DEVICE_OFFLINE_SOURCES = 2;
const preparedSources = new Map<
    string,
    { ownerId: string; url: string; revoke: () => void }
>();
type DeviceOfflinePlaybackTrack = Pick<
    DeviceOfflineTrack,
    "id" | "streamSource" | "tidalTrackId" | "youtubeVideoId"
>;

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

function resolveReadyPlaybackRecord(
    track: DeviceOfflinePlaybackTrack,
    preferredQuality: string = "auto",
): DeviceOfflineDownloadRecord | null {
    if (!activeOwnerId) return null;

    const identity = resolveDeviceOfflineTrackIdentity(track);
    const quality = normalizeDeviceOfflineQuality(preferredQuality);
    const candidates = readyRecords
        .filter(
            (record) =>
                record.ownerId === activeOwnerId &&
                record.trackIdentity === identity,
        )
        .sort((left, right) => right.updatedAt - left.updatedAt);
    return (
        candidates.find((candidate) => candidate.quality === quality) ??
        candidates[0] ??
        null
    );
}

function immediatePlaybackSource(url: string): DeviceAudioPlayResult {
    return { kind: "play", url, release: () => undefined };
}

function playbackAcquisitionAbort(): DOMException {
    return new DOMException(
        "Playback source acquisition was superseded",
        "AbortError",
    );
}

function isPlaybackRecordCurrent(
    ownerId: string,
    key: string,
    authSignal: AbortSignal,
    signal: AbortSignal,
): boolean {
    return (
        !signal.aborted &&
        !authSignal.aborted &&
        activeOwnerId === ownerId &&
        readyRecords.some(
            (record) =>
                record.ownerId === ownerId &&
                record.key === key &&
                record.status === "ready",
        )
    );
}

/** Return the stable ready-record key used to identify device playback. */
export function resolveDeviceOfflinePlaybackIdentity(
    track: DeviceOfflinePlaybackTrack,
    preferredQuality: string = "auto",
): string | null {
    return resolveReadyPlaybackRecord(track, preferredQuality)?.key ?? null;
}

/** Identify engine media by track plus stable ready-record key when present. */
export function resolveDeviceOfflineMediaIdentity(
    track: DeviceOfflinePlaybackTrack,
    preferredQuality: string = "auto",
): string {
    const recordKey = resolveDeviceOfflinePlaybackIdentity(
        track,
        preferredQuality,
    );
    return recordKey ? `${track.id}\u0000${recordKey}` : track.id;
}

/** Check whether the active owner has a verified device copy for this track. */
export function hasDeviceOfflinePlaybackCopy(
    track: DeviceOfflinePlaybackTrack,
    preferredQuality: string = "auto",
): boolean {
    return resolveReadyPlaybackRecord(track, preferredQuality) !== null;
}

/** Acquire a revocable device-file URL, or a no-op legacy/network lease. */
export async function acquireDeviceOfflinePlaybackSource(
    track: DeviceOfflinePlaybackTrack,
    networkUrl: string,
    signal: AbortSignal,
    preferredQuality: string = "auto",
): Promise<DeviceAudioPlayResult> {
    if (signal.aborted) throw playbackAcquisitionAbort();

    const selected = resolveReadyPlaybackRecord(track, preferredQuality);
    if (!selected?.mediaRef) {
        return immediatePlaybackSource(
            selected
                ? (preparedSources.get(selected.key)?.url ??
                      selected.virtualUrl)
                : networkUrl,
        );
    }

    const ownerId = selected.ownerId;
    const recordKey = selected.key;
    const authLease = getAuthRuntimeLease();
    try {
        const session = await getDeviceAudioVault().open({
            ownerId,
            authGeneration: authLease.generation,
        });
        if (
            !isPlaybackRecordCurrent(
                ownerId,
                recordKey,
                authLease.signal,
                signal,
            )
        ) {
            throw playbackAcquisitionAbort();
        }

        const playback = await session.access({
            kind: "play",
            ref: selected.mediaRef,
            expectedBytes: selected.totalBytes,
        });
        if (
            !isPlaybackRecordCurrent(
                ownerId,
                recordKey,
                authLease.signal,
                signal,
            )
        ) {
            playback.release();
            throw playbackAcquisitionAbort();
        }
        return playback;
    } catch (error) {
        if (
            !isPlaybackRecordCurrent(
                ownerId,
                recordKey,
                authLease.signal,
                signal,
            ) ||
            (error instanceof DOMException && error.name === "AbortError")
        ) {
            throw playbackAcquisitionAbort();
        }
        if (error instanceof DeviceAudioVaultError) {
            return immediatePlaybackSource(networkUrl);
        }
        throw error;
    }
}

/** Prefer a ready device copy, falling back to the supplied clean network URL. */
export function resolveDeviceOfflinePlaybackUrl(
    track: DeviceOfflinePlaybackTrack,
    networkUrl: string,
    preferredQuality: string = "auto",
): string {
    const selected = resolveReadyPlaybackRecord(track, preferredQuality);
    if (!selected) return networkUrl;
    return preparedSources.get(selected.key)?.url ?? selected.virtualUrl;
}
