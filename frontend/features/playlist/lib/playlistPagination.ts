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

type PlaylistMergedEntry = PlaylistDetailTrackItem | PlaylistPendingTrackItem;

export function comparePlaylistEntries(
    left: PlaylistMergedEntry,
    right: PlaylistMergedEntry,
): number {
    if (left.sort !== right.sort) return left.sort - right.sort;
    if (left.type !== right.type) return left.type === "track" ? -1 : 1;
    return left.id.localeCompare(right.id);
}

/**
 * Accept only a forward, non-repeating opaque cursor. A malformed `hasMore`
 * response must stop rather than requesting the first page forever.
 */
export function getPlaylistNextPageParam(
    lastPage: PlaylistDetailResponse,
    allPages: PlaylistDetailResponse[],
): string | undefined {
    if (!lastPage.pagination?.hasMore) return undefined;
    const nextCursor = lastPage.pagination.nextCursor?.trim();
    if (!nextCursor) return undefined;

    const priorCursors = new Set(
        allPages
            .slice(0, -1)
            .map((page) => page.pagination?.nextCursor?.trim())
            .filter((cursor): cursor is string => Boolean(cursor)),
    );
    return priorCursors.has(nextCursor) ? undefined : nextCursor;
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
        mergedItems: [...items, ...pendingTracks].sort(comparePlaylistEntries),
        pagination: last.pagination,
    };
}
