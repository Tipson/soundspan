import type { Track } from "@/lib/audio-state-context";
import type {
    PlaylistDetailResponse,
    PlaylistDetailTrackItem,
    PlaylistPendingTrackItem,
} from "@/lib/api";
import { isPlayableTrackItem, toAudioTrack } from "@/lib/playlistItemPlayback";
import {
    comparePlaylistEntries,
    mergePlaylistDetailPages,
} from "./playlistPagination";

export type ProgressivePlaylistPlaybackStatus =
    | "completed"
    | "cancelled"
    | "queue-changed"
    | "fetch-failed"
    | "invalid-pagination"
    | "no-playable";

export interface ProgressivePlaylistPlaybackResult {
    status: ProgressivePlaylistPlaybackStatus;
    playableCount: number;
}

export interface PlaylistNextPageResult {
    data?: { pages: PlaylistDetailResponse[] };
    hasNextPage?: boolean;
    isError?: boolean;
    error?: unknown;
}

interface ProgressivePlaylistPlaybackOptions {
    initialPages: PlaylistDetailResponse[];
    initialHasNextPage: boolean;
    fetchNextPage: () => Promise<PlaylistNextPageResult>;
    isCurrentIntent: () => boolean;
    getCurrentQueueKeys: () => string[];
    getCurrentPlaybackKey?: () => string | null;
    playTracks: (tracks: Track[]) => void;
    appendTracks: (tracks: Track[]) => void;
    retryCount?: number;
}

function entryKey(entry: { type: "track" | "pending"; id: string }): string {
    return `${entry.type}:${entry.id}`;
}

/** Keeps duplicate playlist positions distinct while guarding queue ownership. */
export function playlistQueueEntryKey(
    track: Pick<Track, "id" | "playlistItemId">,
): string {
    return track.playlistItemId
        ? `playlist-item:${track.playlistItemId}`
        : `track:${track.id}`;
}

function queueMatches(actualIds: string[], expectedIds: string[]): boolean {
    return (
        actualIds.length === expectedIds.length &&
        actualIds.every((id, index) => id === expectedIds[index])
    );
}

function hasMoreFromPages(
    pages: PlaylistDetailResponse[],
    fallback: boolean,
): boolean {
    return pages.at(-1)?.pagination?.hasMore ?? fallback;
}

function hasInvalidContinuation(
    pages: PlaylistDetailResponse[],
    hasNextPage: boolean,
): boolean {
    return pages.at(-1)?.pagination?.hasMore === true && !hasNextPage;
}

async function fetchNextPageWithRetry(
    fetchNextPage: () => Promise<PlaylistNextPageResult>,
    retryCount: number,
    isCurrentIntent: () => boolean,
): Promise<PlaylistNextPageResult | null> {
    let attempt = 0;
    while (attempt <= retryCount) {
        if (!isCurrentIntent()) return null;
        try {
            const result = await fetchNextPage();
            if (!result.isError) return result;
            if (attempt === retryCount) return result;
        } catch (error) {
            if (attempt === retryCount) {
                return { isError: true, error };
            }
        }
        attempt += 1;
    }
    return { isError: true };
}

/**
 * Starts from the pages already on screen, then appends each newly fetched
 * playable slice while the initiating queue remains untouched. Playlist item
 * identity (not track identity) removes repeated cursor boundaries, so an
 * intentional duplicate track position is preserved.
 */
export async function playPlaylistProgressively({
    initialPages,
    initialHasNextPage,
    fetchNextPage,
    isCurrentIntent,
    getCurrentQueueKeys,
    getCurrentPlaybackKey = () => null,
    playTracks,
    appendTracks,
    retryCount = 1,
}: ProgressivePlaylistPlaybackOptions): Promise<ProgressivePlaylistPlaybackResult> {
    let pages = initialPages;
    let hasMore = initialHasNextPage;
    let priorPageCount = pages.length;
    let expectedQueueKeys: string[] | null = null;
    let playableCount = 0;
    const seenEntries = new Set<string>();
    const initialQueueKeys = getCurrentQueueKeys();
    const initialPlaybackKey = getCurrentPlaybackKey();
    let lastEntry: PlaylistDetailTrackItem | PlaylistPendingTrackItem | null =
        null;

    const applyNewEntries = (): ProgressivePlaylistPlaybackStatus | null => {
        const merged = mergePlaylistDetailPages(pages);
        const entries = merged?.mergedItems ?? [];
        const newEntries = entries.filter(
            (entry) => !seenEntries.has(entryKey(entry)),
        );
        if (
            lastEntry &&
            newEntries.some(
                (entry) => comparePlaylistEntries(entry, lastEntry!) < 0,
            )
        ) {
            return "invalid-pagination";
        }
        newEntries.forEach((entry) => seenEntries.add(entryKey(entry)));
        lastEntry = newEntries.at(-1) ?? lastEntry;
        const tracks = newEntries.flatMap((entry) =>
            entry.type === "track" && isPlayableTrackItem(entry)
                ? [toAudioTrack(entry)]
                : [],
        );
        if (tracks.length === 0) return null;
        if (!isCurrentIntent()) return "cancelled";

        if (expectedQueueKeys === null) {
            if (
                !queueMatches(getCurrentQueueKeys(), initialQueueKeys) ||
                getCurrentPlaybackKey() !== initialPlaybackKey
            ) {
                return "queue-changed";
            }
            playTracks(tracks);
            expectedQueueKeys = tracks.map(playlistQueueEntryKey);
            playableCount += tracks.length;
            return null;
        }
        if (!queueMatches(getCurrentQueueKeys(), expectedQueueKeys)) {
            return "queue-changed";
        }
        appendTracks(tracks);
        expectedQueueKeys = [
            ...expectedQueueKeys,
            ...tracks.map(playlistQueueEntryKey),
        ];
        playableCount += tracks.length;
        return null;
    };

    const initialStatus = applyNewEntries();
    if (initialStatus) return { status: initialStatus, playableCount };
    if (hasInvalidContinuation(pages, initialHasNextPage)) {
        return { status: "invalid-pagination", playableCount };
    }

    while (hasMore) {
        if (!isCurrentIntent()) return { status: "cancelled", playableCount };
        if (
            expectedQueueKeys !== null &&
            !queueMatches(getCurrentQueueKeys(), expectedQueueKeys)
        ) {
            return { status: "queue-changed", playableCount };
        }

        const result = await fetchNextPageWithRetry(
            fetchNextPage,
            retryCount,
            isCurrentIntent,
        );
        if (!isCurrentIntent() || result === null) {
            return { status: "cancelled", playableCount };
        }
        if (result.isError) {
            return { status: "fetch-failed", playableCount };
        }
        const nextPages = result.data?.pages;
        if (!nextPages || nextPages.length <= priorPageCount) {
            return { status: "invalid-pagination", playableCount };
        }
        pages = nextPages;
        priorPageCount = pages.length;
        hasMore = result.hasNextPage ?? hasMoreFromPages(pages, false);

        const pageStatus = applyNewEntries();
        if (pageStatus) return { status: pageStatus, playableCount };
        if (hasInvalidContinuation(pages, hasMore)) {
            return { status: "invalid-pagination", playableCount };
        }
    }

    return {
        status: playableCount > 0 ? "completed" : "no-playable",
        playableCount,
    };
}
