import type { LikedPlaylistTrack, TrackPreferenceSignal } from "@/lib/api";
import {
    hasLocalTrackBacking,
    isTrackActionable,
    resolveTrackProviderSource,
    toTrackRef,
} from "@/lib/trackRef";
import type { DeviceOfflineTrack } from "./types";

export const DEVICE_OFFLINE_LIKED_CHANGE_EVENT =
    "soundspan:device-offline-liked-change";

export interface DeviceOfflineLikedEventTarget {
    addEventListener(type: string, listener: EventListener): void;
    removeEventListener(type: string, listener: EventListener): void;
    dispatchEvent(event: Event): boolean;
}

function defaultEventTarget(): DeviceOfflineLikedEventTarget | null {
    return typeof window === "undefined" ? null : window;
}

/** Wake the active tab after a successful thumbs-up mutation. */
export function publishDeviceOfflineLikedChange(
    target: DeviceOfflineLikedEventTarget | null = defaultEventTarget(),
): void {
    target?.dispatchEvent(new Event(DEVICE_OFFLINE_LIKED_CHANGE_EVENT));
}

/** Publish only a confirmed thumbs-up; clear and dislike never enqueue work. */
export function publishDeviceOfflineLikedChangeForSignal(
    signal: TrackPreferenceSignal,
    target: DeviceOfflineLikedEventTarget | null = defaultEventTarget(),
): boolean {
    if (signal !== "thumbs_up") return false;
    publishDeviceOfflineLikedChange(target);
    return true;
}

/** Subscribe to successful liked-song changes in this browser tab. */
export function subscribeToDeviceOfflineLikedChanges(
    listener: () => void,
    target: DeviceOfflineLikedEventTarget | null = defaultEventTarget(),
): () => void {
    if (!target) return () => undefined;
    const handleEvent: EventListener = () => listener();
    target.addEventListener(DEVICE_OFFLINE_LIKED_CHANGE_EVENT, handleEvent);
    return () =>
        target.removeEventListener(
            DEVICE_OFFLINE_LIKED_CHANGE_EVENT,
            handleEvent,
        );
}

/** Exclude liked metadata that cannot resolve to an approved audio route. */
export function isLikedPlaylistTrackDownloadable(
    track: LikedPlaylistTrack,
): boolean {
    if (!isTrackActionable(track)) return false;
    if (hasLocalTrackBacking(track)) return Boolean(track.id);
    const source = resolveTrackProviderSource(track);
    if (source === "peer") return false;
    if (source === "youtube" || source === "youtube-direct") {
        return Boolean(track.youtubeVideoId ?? track.provider?.youtubeVideoId);
    }
    if (track.youtubeVideoId ?? track.provider?.youtubeVideoId) return true;
    return false;
}

/** Convert a My Liked API row into portable, device-local track metadata. */
export function likedPlaylistTrackToDeviceTrack(
    track: LikedPlaylistTrack,
): DeviceOfflineTrack {
    const isLocal = hasLocalTrackBacking(track);
    const reference = isLocal ? null : toTrackRef(track);
    const youtubeVideoId =
        reference && "youtubeVideoId" in reference
            ? reference.youtubeVideoId
            : undefined;

    return {
        id: track.id,
        title: track.title,
        duration: track.duration,
        filePath: track.filePath || undefined,
        source: isLocal ? "local" : youtubeVideoId ? "youtube" : undefined,
        streamSource: youtubeVideoId ? "youtube" : undefined,
        youtubeVideoId,
        tidalTrackId: undefined,
        artist: {
            id: track.artist.id ?? undefined,
            name: track.artist.name,
        },
        album: {
            id: track.album.id ?? undefined,
            title: track.album.title,
            coverArt: track.album.coverArt,
        },
    };
}
