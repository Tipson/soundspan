import type {
    PlaylistDetailResponse,
    PlaylistDetailTrackItem,
    PlaylistPendingTrackItem,
} from "@/lib/api";

function uniqueById<T extends { id: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    });
}

/** Flatten cursor pages while tolerating a repeated boundary after mutations. */
export function mergePlaylistDetailPages(
    pages: PlaylistDetailResponse[],
): PlaylistDetailResponse | undefined {
    const first = pages[0];
    if (!first) return undefined;
    const items = uniqueById<PlaylistDetailTrackItem>(
        pages.flatMap((page) => page.items),
    );
    const pendingTracks = uniqueById<PlaylistPendingTrackItem>(
        pages.flatMap((page) => page.pendingTracks),
    );
    const last = pages[pages.length - 1];
    return {
        ...first,
        items,
        pendingTracks,
        mergedItems: [...items, ...pendingTracks].sort(
            (left, right) => left.sort - right.sort,
        ),
        pagination: last.pagination,
    };
}
