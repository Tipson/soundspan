import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { DiscoverResult } from "@/features/search/types";
import { normalizeYtMusicArtist } from "../ytMusicArtist";
import { resolveProviderArtistChannel } from "../providerArtistFallback";

const PROVIDER_ARTIST_SEARCH_LIMIT = 20;

/** Extend a local artist shadow with the exact online provider catalog. */
export function useProviderArtistFallback(
    artistName: string,
    enabled: boolean,
) {
    const normalizedArtistName = artistName.trim();
    const canSearch = enabled && normalizedArtistName.length >= 2;
    const searchQuery = useQuery({
        queryKey: queryKeys.discoverSearch(
            normalizedArtistName,
            "music",
            PROVIDER_ARTIST_SEARCH_LIMIT,
        ),
        queryFn: () =>
            api.discoverSearch(
                normalizedArtistName,
                "music",
                PROVIDER_ARTIST_SEARCH_LIMIT,
            ),
        enabled: canSearch,
        staleTime: 5 * 60 * 1000,
        retry: 1,
    });
    const channelId = resolveProviderArtistChannel(
        (searchQuery.data?.results ?? []) as DiscoverResult[],
        normalizedArtistName,
    );
    const artistQuery = useQuery({
        queryKey: queryKeys.ytMusicArtist(channelId ?? ""),
        queryFn: async () => {
            if (!channelId) {
                throw new Error("YouTube Music channel ID is required");
            }
            const payload = await api.getYtMusicArtist(channelId);
            return normalizeYtMusicArtist(payload, {
                channelId,
                fallbackName: normalizedArtistName,
            });
        },
        enabled: canSearch && Boolean(channelId),
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });

    return {
        data: artistQuery.data,
        channelId,
        isLoading:
            canSearch &&
            (searchQuery.isLoading ||
                searchQuery.isFetching ||
                (Boolean(channelId) &&
                    (artistQuery.isLoading || artistQuery.isFetching))),
        isError: searchQuery.isError || artistQuery.isError,
    };
}
