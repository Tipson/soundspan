import {
    resolveAlbumSource,
    type Album,
    type AlbumSource,
    type Track,
} from "./types";

/** One source-aware availability rule shared by album rows and bulk playback. */
export function isAlbumTrackPlayable(
    track: Track,
    source: AlbumSource,
): boolean {
    if (track.source === "federated") {
        return track.peer?.online === true;
    }
    if (source === "library") return true;
    if (track.streamSource === "tidal") {
        return Boolean(track.tidalTrackId);
    }
    if (track.streamSource === "youtube") {
        return Boolean(track.youtubeVideoId?.trim());
    }
    return false;
}

/** Maps an album-page track into the player queue shape without losing provider artwork. */
export function toAlbumPlaybackTrack(track: Track, album: Album) {
    return {
        id: track.id,
        title: track.title,
        duration: track.duration,
        artist: {
            name: track.artist?.name || album.artist?.name || "",
            id: track.artist?.id || album.artist?.id || "",
        },
        album: {
            title: album.title,
            id: album.id,
            coverArt:
                track.album?.coverArt ??
                track.thumbnailUrl ??
                album.coverArt ??
                album.coverUrl,
            albumLoudnessLufs: album.albumLoudnessLufs ?? null,
            albumTruePeakDb: album.albumTruePeakDb ?? null,
        },
        loudnessLufs: track.loudnessLufs ?? null,
        truePeakDb: track.truePeakDb ?? null,
        filePath: track.filePath,
        source: track.source,
        peer: track.peer,
        ...(track.streamSource === "tidal" && {
            streamSource: "tidal" as const,
            tidalTrackId: track.tidalTrackId,
        }),
        ...(track.streamSource === "youtube" && {
            streamSource: "youtube" as const,
            youtubeVideoId: track.youtubeVideoId,
        }),
        ...(track.streamSource === "peer" && {
            streamSource: "peer" as const,
        }),
    };
}

/**
 * Builds the playable album snapshot for a row selection. The selected row is
 * resolved by object position before offline peers are removed, so duplicate
 * provider IDs and filtered rows cannot shift playback to the wrong song.
 */
export function selectAlbumPlaybackQueue(
    album: Album,
    selectedRowIndex: number,
    source: AlbumSource = resolveAlbumSource(album) ?? "discovery",
) {
    const albumTracks = album.tracks ?? [];
    const selectedTrack = albumTracks[selectedRowIndex] ?? null;
    const playableTracks = albumTracks.filter((track) =>
        isAlbumTrackPlayable(track, source),
    );
    const selectedPlayableIndex = selectedTrack
        ? playableTracks.indexOf(selectedTrack)
        : -1;

    return {
        tracks: playableTracks.map((track) =>
            toAlbumPlaybackTrack(track, album),
        ),
        startIndex: selectedPlayableIndex >= 0 ? selectedPlayableIndex : 0,
    };
}
