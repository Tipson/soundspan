import type { LikeableTrack } from "@/hooks/useCollectionLikeAll";
import { api, type PlaylistDetailTrackItem } from "@/lib/api";
import type { PlayablePlaylistItem } from "@/lib/playlistItemPlayback";
import {
    createMosaicCandidates,
    selectMosaicCovers,
} from "@/utils/mosaicCoverSelection";

/** Maps playable playlist rows to the metadata accepted by bulk preferences. */
export function buildPlaylistLikeableTracks(
    items: PlayablePlaylistItem[],
): LikeableTrack[] {
    return items.map((item) => ({
        id: item.track.id,
        title: item.track.title,
        artist: item.track.album.artist.name,
        album: item.track.album.title,
        duration: item.track.duration,
    }));
}

/** Selects a diverse four-cover mosaic for a playlist hero. */
export function buildPlaylistCoverUrls(
    items: PlaylistDetailTrackItem[],
): string[] {
    if (items.length === 0) return [];
    const candidates = createMosaicCandidates(items, {
        getId: (item) => item.id,
        getCoverUrl: (item) => item.track?.album?.coverArt,
        getArtistKey: (item) => item.track?.album?.artist?.name?.toLowerCase(),
        getAlbumKey: (item) => item.track?.album?.title?.toLowerCase(),
    });
    return selectMosaicCovers(candidates, { count: 4 }).map((result) =>
        api.getCoverArtUrl(result.coverUrl, 200),
    );
}
