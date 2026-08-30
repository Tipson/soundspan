import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { LibraryTrack, SearchResult } from "../types";

/** One bounded page supported by the local `/search` offset contract. */
export const LIBRARY_TRACK_SEARCH_PAGE_SIZE = 50;

/** Page through every local/federated track match without a client-side cap. */
export function useLibraryTrackSearch(
    query: string,
    source: "all" | "local" | "peers",
    enabled: boolean,
) {
    const search = useInfiniteQuery({
        queryKey: queryKeys.searchTracks(query, source),
        queryFn: async ({ pageParam, signal }): Promise<SearchResult> =>
            (await api.search(
                query,
                "tracks",
                LIBRARY_TRACK_SEARCH_PAGE_SIZE,
                signal,
                source,
                pageParam,
            )) as SearchResult,
        initialPageParam: 0,
        getNextPageParam: (lastPage, allPages) => {
            const pageTracks = lastPage.tracks ?? [];
            return pageTracks.length === LIBRARY_TRACK_SEARCH_PAGE_SIZE
                ? allPages.length * LIBRARY_TRACK_SEARCH_PAGE_SIZE
                : undefined;
        },
        enabled: enabled && query.trim().length >= 2,
        staleTime: 5 * 60 * 1000,
    });

    const seen = new Set<string>();
    const tracks: LibraryTrack[] = [];
    for (const page of search.data?.pages ?? []) {
        for (const track of page.tracks ?? []) {
            if (seen.has(track.id)) continue;
            seen.add(track.id);
            tracks.push(track);
        }
    }

    return { ...search, tracks };
}
