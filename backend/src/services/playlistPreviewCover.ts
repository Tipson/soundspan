interface PlaylistPreviewCoverSources {
    track?: { album: { coverUrl: string | null } } | null;
    trackTidal?: { albumEntity: { coverUrl: string | null } | null } | null;
    trackYtMusic?: {
        thumbnailUrl: string | null;
        albumEntity: { coverUrl: string | null } | null;
    } | null;
}

/** Bounded fields needed by the playlist-list mosaic. */
export const playlistPreviewItemSelect = {
    id: true,
    sort: true,
    track: { select: { album: { select: { coverUrl: true } } } },
    trackTidal: { select: { albumEntity: { select: { coverUrl: true } } } },
    trackYtMusic: {
        select: {
            thumbnailUrl: true,
            albumEntity: { select: { coverUrl: true } },
        },
    },
} as const;

/** Prefer canonical album art, then a provider thumbnail for playlist mosaics. */
export function resolvePlaylistPreviewCover(
    item: PlaylistPreviewCoverSources,
): string | null {
    return (
        item.track?.album.coverUrl ??
        item.trackYtMusic?.albumEntity?.coverUrl ??
        item.trackYtMusic?.thumbnailUrl ??
        item.trackTidal?.albumEntity?.coverUrl ??
        null
    );
}
