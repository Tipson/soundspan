import type { PlaylistDetailTrackItem } from "@/lib/api";
import type { Track as AudioTrack } from "@/lib/audio-context";

export const TRACK_REMOVED_TOOLTIP =
    "Файл удалён из медиатеки — восстановите его, чтобы вернуть трек";

/** Playlist row whose track is present and currently playable. */
export interface PlayablePlaylistItem extends PlaylistDetailTrackItem {
    track: NonNullable<PlaylistDetailTrackItem["track"]>;
}

/** Returns whether a playlist row can be played right now. */
export function isPlayableTrackItem(
    item: PlaylistDetailTrackItem,
): item is PlayablePlaylistItem {
    return Boolean(item.track && item.playback?.isPlayable !== false);
}

/** Returns whether a playlist row is a locally sourced playable track. */
export function isLocalPlayableTrackItem(
    item: PlaylistDetailTrackItem,
): item is PlayablePlaylistItem {
    if (!isPlayableTrackItem(item)) return false;
    return (
        item.track.source !== "federated" &&
        (item.provider?.source || "local") === "local"
    );
}

/** Explains why a playlist row cannot be played. */
export function getUnplayableMessage(item: PlaylistDetailTrackItem): string {
    if (item.playback?.reason === "track_removed") {
        return TRACK_REMOVED_TOOLTIP;
    }
    if (item.playback?.reason === "peer_offline") {
        return "Удалённый сервер сейчас не в сети.";
    }
    const backendMessage = item.playback?.message?.trim();
    if (backendMessage && /[А-Яа-яЁё]/.test(backendMessage)) {
        return backendMessage;
    }
    return "Сейчас этот трек недоступен для воспроизведения.";
}

/** Maps a playable playlist row onto the audio-context track shape. */
export function toAudioTrack(item: PlayablePlaylistItem): AudioTrack {
    const track = item.track;
    return {
        id: track.id,
        title: track.title,
        artist: {
            name: track.album.artist.name,
            id: track.album.artist.id,
        },
        album: {
            title: track.album.title,
            coverArt: track.album.coverArt || undefined,
            id: track.album.id,
        },
        duration: track.duration,
        playlistItemId: item.id,
        ...(item.trackYtMusicId ? { trackYtMusicId: item.trackYtMusicId } : {}),
        source: track.source,
        peer: track.peer,
        ...(track.streamSource === "tidal"
            ? {
                  streamSource: "tidal" as const,
                  tidalTrackId: track.tidalTrackId,
              }
            : {}),
        ...(track.streamSource === "youtube"
            ? {
                  streamSource: "youtube" as const,
                  youtubeVideoId: track.youtubeVideoId,
              }
            : {}),
        ...(track.streamSource === "peer"
            ? { streamSource: "peer" as const }
            : {}),
    };
}

/**
 * Builds the ordered playable queue represented by a playlist detail view and
 * resolves the selected playlist item to its index in that filtered queue.
 */
export function selectPlaylistPlaybackQueue(
    items: readonly PlaylistDetailTrackItem[],
    selectedItemId: string,
): { tracks: AudioTrack[]; startIndex: number } {
    const playableItems = items.filter(isPlayableTrackItem);
    const startIndex = playableItems.findIndex(
        (item) => item.id === selectedItemId,
    );
    if (startIndex < 0) return { tracks: [], startIndex: -1 };
    return {
        tracks: playableItems.map(toAudioTrack),
        startIndex,
    };
}
