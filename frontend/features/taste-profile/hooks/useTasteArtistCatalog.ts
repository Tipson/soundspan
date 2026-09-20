"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

interface ArtistPage {
    artists: string[];
    nextPage: number | null;
}
interface Cursor {
    genreIndex: number;
    pages: (number | null)[];
}

/** Lazily interleave selected genre pages; cache filters separately and abort stale requests. */
export function useTasteArtistCatalog(genres: string[], enabled: boolean) {
    const filters = genres.length ? genres : ["all"];
    const query = useInfiniteQuery({
        queryKey: queryKeys.tasteArtistCatalog(filters),
        initialPageParam: {
            genreIndex: 0,
            pages: filters.map(() => 1),
        } as Cursor,
        queryFn: async ({ pageParam, signal }) => {
            const genre = filters[pageParam.genreIndex];
            const result = await api.request<ArtistPage>(
                `/taste-profile/artists?genre=${encodeURIComponent(genre)}&page=${pageParam.pages[pageParam.genreIndex]}`,
                { signal, timeoutMs: 20_000, retryOnTimeout: false },
            );
            if (
                !Array.isArray(result.artists) ||
                !(
                    result.nextPage === null ||
                    (Number.isSafeInteger(result.nextPage) &&
                        result.nextPage! >
                            pageParam.pages[pageParam.genreIndex]!)
                )
            )
                throw new Error("Invalid catalog page");
            const pages = [...pageParam.pages];
            pages[pageParam.genreIndex] = result.nextPage;
            let next: Cursor | undefined;
            for (let offset = 1; offset <= filters.length; offset++) {
                const index = (pageParam.genreIndex + offset) % filters.length;
                if (pages[index] !== null) {
                    next = { genreIndex: index, pages };
                    break;
                }
            }
            return { artists: result.artists, next };
        },
        getNextPageParam: (last) => last.next,
        enabled,
        staleTime: 15 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
    });
    const seen = new Set<string>();
    const artists = query.data?.pages
        .flatMap((page) => page.artists)
        .filter((name) => {
            const key = name.toLocaleLowerCase("en-US");
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    return { ...query, artists };
}
