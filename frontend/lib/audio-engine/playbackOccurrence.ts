import type { Track } from "@/lib/audio-state-context";
import {
    writePlaybackAdvanceOrigin,
    writePlaybackReplacementIntent,
} from "./playbackAdvanceOrigin";

type PlaybackOccurrenceTrack = Pick<
    Track,
    "id" | "playlistItemId" | "provider" | "tidalTrackId" | "youtubeVideoId"
>;

function normalizedText(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized || null;
}

function mediaIdentity(track: PlaybackOccurrenceTrack): string {
    const youtubeVideoId = normalizedText(
        track.youtubeVideoId ?? track.provider?.youtubeVideoId,
    );
    if (youtubeVideoId) return `youtube:${youtubeVideoId}`;

    const tidalTrackId = track.tidalTrackId ?? track.provider?.tidalTrackId;
    if (tidalTrackId) return `tidal:${tidalTrackId}`;

    const providerTrackId = normalizedText(track.provider?.providerTrackId);
    if (providerTrackId) {
        return `${track.provider?.source ?? "provider"}:${providerTrackId}`;
    }

    return `track:${track.id}`;
}

/** Adds a playlist-row identity to an engine media key when one exists. */
export function resolvePlaybackOccurrenceMediaIdentity(
    track: PlaybackOccurrenceTrack,
    mediaKey: string = mediaIdentity(track),
): string {
    const playlistItemId = normalizedText(track.playlistItemId);
    return playlistItemId
        ? `${mediaKey}\u0000playlist-item:${playlistItemId}`
        : mediaKey;
}

/** Matches the row already playing without collapsing duplicate playlist rows. */
export function isSamePlaybackOccurrence(
    currentTrack: PlaybackOccurrenceTrack | null,
    selectedTrack: PlaybackOccurrenceTrack,
): boolean {
    if (!currentTrack) return false;

    const currentItemId = normalizedText(currentTrack.playlistItemId);
    const selectedItemId = normalizedText(selectedTrack.playlistItemId);
    if (currentItemId && selectedItemId) {
        return currentItemId === selectedItemId;
    }

    return mediaIdentity(currentTrack) === mediaIdentity(selectedTrack);
}

/**
 * Marks a new manual selection, or toggles the currently playing occurrence.
 * Returns true only when the repeated click was fully handled.
 */
export function applyTrackClick(
    state: {
        playbackType: string | null;
        currentTrack: PlaybackOccurrenceTrack | null;
    },
    playback: {
        isPlaying: boolean;
        setIsPlaying(value: boolean): void;
    },
    selectedTrack: PlaybackOccurrenceTrack,
): boolean {
    if (
        state.playbackType !== "track" ||
        !isSamePlaybackOccurrence(state.currentTrack, selectedTrack)
    ) {
        writePlaybackReplacementIntent(state.currentTrack?.id ?? null);
        return false;
    }

    if (!playback.isPlaying) {
        writePlaybackAdvanceOrigin("manual", selectedTrack.id);
    }
    playback.setIsPlaying(!playback.isPlaying);
    return true;
}
