import { useInfiniteQuery } from "@tanstack/react-query";
import {
    api,
    type SavedMusicEntity,
    type SavedMusicEntityType,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { parseSavedEntitySearchPage } from "../savedEntitySearch";

/** Search explicit account saves independently from provider/local catalog pages. */
export function useSavedEntitySearch(
    query: string,
    type: SavedMusicEntityType,
    enabled: boolean,
) {
    const q = query.trim();
    const active = enabled && q.length >= 2 && q.length <= 500;
    const search = useInfiniteQuery({
        queryKey: queryKeys.savedMusicSearch(q, type),
        initialPageParam: 0,
        queryFn: async ({ pageParam, signal }) => {
            const value = await api.listSavedMusicEntities(
                { type, q, offset: pageParam, limit: 50 },
                signal,
            );
            return parseSavedEntitySearchPage(value, {
                query: q,
                type,
                offset: pageParam,
                limit: 50,
            });
        },
        getNextPageParam: (page) => page.nextOffset,
        enabled: active,
        retry: false,
        staleTime: (state) =>
            state.state.data?.pages.some((page) => page.partial) ? 0 : 60_000,
    });
    const items: SavedMusicEntity[] = [],
        seen = new Set<string>();
    for (const page of active ? (search.data?.pages ?? []) : []) {
        for (const item of page.items) {
            const key = `${item.entityType}:${item.source}:${item.entityId}`;
            if (!seen.has(key)) {
                seen.add(key);
                items.push(item);
            }
        }
    }
    return {
        ...search,
        retry: () =>
            search.isFetchNextPageError
                ? search.fetchNextPage()
                : search.refetch(),
        items,
        hasNextPage: active && search.hasNextPage,
        isLoading: active && search.isLoading,
        isFetching: active && search.isFetching,
        isError: active && search.isError,
        partial:
            active &&
            (search.isError ||
                search.data?.pages.some((page) => page.partial) === true),
    };
}

/** Current private match list and its independent loading/retry controls. */
export type SavedEntitySearchState = ReturnType<typeof useSavedEntitySearch>;
