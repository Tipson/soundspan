import type { LikedPlaylistTrack } from "@/lib/api";
import type { Track as AudioTrack } from "@/lib/audio-state-context";
import {
    isTrackActionable,
    normalizeActionableAudioTrack,
} from "@/lib/trackRef";

// Re-export the type for test convenience
export type { LikedPlaylistTrack };

/**
 * Converts a LikedPlaylistTrack to an AudioTrack for playback.
 * Preserves remote provider identity and the complete direct recording contract.
 */
export function toAudioTrack(track: LikedPlaylistTrack): AudioTrack | null {
    if (!isTrackActionable(track)) return null;
    if (
        track.source === "vk" ||
        track.source === "yandex" ||
        /^(vk|yandex):/.test(track.id)
    ) {
        return normalizeActionableAudioTrack({
            id: track.id,
            title: track.title,
            duration: track.duration,
            artist: {
                id: track.artist.id ?? undefined,
                name: track.artist.name,
            },
            album: {
                id: track.album.id ?? undefined,
                title: track.album.title,
                coverArt: track.album.coverArt,
            },
            filePath: track.filePath || undefined,
            source:
                track.source === "vk" || track.source === "yandex"
                    ? track.source
                    : undefined,
            streamSource: track.streamSource,
            provider: track.provider?.source
                ? {
                      source: track.provider.source,
                      providerTrackId: track.provider.providerTrackId,
                  }
                : undefined,
            musicSourceRecording: track.musicSourceRecording,
        });
    }
    const providerYtId =
        typeof track.provider?.youtubeVideoId === "string"
            ? track.provider.youtubeVideoId
            : null;

    return normalizeActionableAudioTrack({
        id: track.id,
        title: track.title,
        artist: {
            id: track.artist.id ?? undefined,
            name: track.artist.name,
        },
        album: {
            id: track.album.id ?? undefined,
            title: track.album.title,
            coverArt: track.album.coverArt,
        },
        duration: track.duration,
        filePath: track.filePath || undefined,
        provider: providerYtId
            ? {
                  source: "youtube",
                  providerTrackId: providerYtId,
                  youtubeVideoId: providerYtId,
              }
            : undefined,
        source:
            track.source === "local" ||
            track.source === "tidal" ||
            track.source === "youtube"
                ? track.source
                : undefined,
        streamSource: track.streamSource,
        youtubeVideoId: track.youtubeVideoId ?? providerYtId ?? undefined,
        tidalTrackId:
            typeof track.tidalTrackId === "number"
                ? track.tidalTrackId
                : undefined,
    });
}

/** Keeps historical metadata available to safe row actions without queueing it. */
export function toLikedTrackActionTarget(
    track: LikedPlaylistTrack,
): AudioTrack {
    const playable = toAudioTrack(track);
    if (playable) return playable;
    const tidalTrackId = Number(
        track.tidalTrackId ?? track.provider?.tidalTrackId,
    );
    const providerYoutubeVideoId = track.provider?.youtubeVideoId ?? undefined;
    const actionTrack: AudioTrack = {
        id: track.id,
        title: track.title,
        artist: {
            id: track.artist.id ?? undefined,
            name: track.artist.name,
        },
        album: {
            id: track.album.id ?? undefined,
            title: track.album.title,
            coverArt: track.album.coverArt,
        },
        duration: track.duration,
        filePath: track.filePath || undefined,
        provider: providerYoutubeVideoId
            ? {
                  source: "youtube",
                  providerTrackId: providerYoutubeVideoId,
                  youtubeVideoId: providerYoutubeVideoId,
              }
            : undefined,
        source:
            track.source === "local" ||
            track.source === "tidal" ||
            track.source === "youtube"
                ? track.source
                : undefined,
        streamSource: track.streamSource,
        youtubeVideoId:
            track.youtubeVideoId ?? providerYoutubeVideoId ?? undefined,
        tidalTrackId:
            Number.isSafeInteger(tidalTrackId) && tidalTrackId > 0
                ? tidalTrackId
                : undefined,
    };
    return normalizeActionableAudioTrack(actionTrack) ?? actionTrack;
}

/** Selects liked rows that may participate in playback and mutation actions. */
export function selectActionableLikedTracks(
    tracks: readonly LikedPlaylistTrack[],
): LikedPlaylistTrack[] {
    return tracks.filter(isTrackActionable);
}
