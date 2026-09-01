import { BRAND_SLUG } from "@/lib/brand";
import { createMigratingStorageKey } from "@/lib/storage-migration";
import {
    LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX,
    QUEUE_CLEARED_AT_KEY_SUFFIX,
} from "@/lib/playback-state-cadence";

type PlaybackStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const OWNER_KEY = `${BRAND_SLUG}_playback_owner_id`;
const USER_BOUND_KEYS = [
    "current_track",
    "current_audiobook",
    "current_podcast",
    "playback_type",
    "queue",
    "current_index",
    "is_shuffle",
    "is_playing",
    "current_time",
    "current_time_track_id",
    LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX,
    QUEUE_CLEARED_AT_KEY_SUFFIX,
].map((suffix) => createMigratingStorageKey(suffix));

let playbackStorageGeneration = 0;

function defaultStorage(): PlaybackStorage | null {
    return typeof window === "undefined" ? null : window.localStorage;
}

function removeUserBoundValues(storage: PlaybackStorage): void {
    for (const key of USER_BOUND_KEYS) {
        try {
            storage.removeItem(key.current);
            if (key.legacy !== key.current) {
                storage.removeItem(key.legacy);
            }
        } catch {
            // Continue clearing the remaining keys in restricted storage.
        }
    }
}

/** Return the in-tab generation captured by playback persistence providers. */
export function getUserPlaybackStorageGeneration(): number {
    return playbackStorageGeneration;
}

/** Reject writes scheduled by a playback provider from an older auth session. */
export function isUserPlaybackStorageGenerationCurrent(
    generation: number,
): boolean {
    return generation === playbackStorageGeneration;
}

/**
 * Prepare user-bound playback storage before mounting an authenticated audio
 * runtime. Unowned legacy data is cleared because its account cannot be proven.
 */
export function activateUserPlaybackStorage(
    ownerId: string,
    storage: PlaybackStorage | null = defaultStorage(),
): number {
    if (!ownerId) {
        revokeUserPlaybackStorage(storage);
        return playbackStorageGeneration;
    }
    if (!storage) return playbackStorageGeneration;

    let currentOwner: string | null = null;
    try {
        currentOwner = storage.getItem(OWNER_KEY);
    } catch {
        // Treat inaccessible ownership metadata as untrusted legacy data.
    }
    if (currentOwner === ownerId) return playbackStorageGeneration;

    playbackStorageGeneration += 1;
    removeUserBoundValues(storage);
    try {
        storage.setItem(OWNER_KEY, ownerId);
    } catch {
        // Playback remains available in memory when storage is restricted.
    }
    return playbackStorageGeneration;
}

/** Revoke the current account's local queue, media identity, and resume state. */
export function revokeUserPlaybackStorage(
    storage: PlaybackStorage | null = defaultStorage(),
): void {
    playbackStorageGeneration += 1;
    if (!storage) return;
    removeUserBoundValues(storage);
    try {
        storage.removeItem(OWNER_KEY);
    } catch {
        // Storage revocation is best effort in restricted browser contexts.
    }
}
