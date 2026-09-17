import {
    useSearchQuery,
    useDiscoverSearchQuery,
    useDiscoverSimilarArtistsQuery,
} from "@/hooks/useQueries";
import type { SearchResult, DiscoverResult, AliasInfo } from "../types";
import { deriveDiscoverySelection } from "../discoverySelection";
import { useMemo } from "react";
import { useLibraryTrackSearch } from "./useLibraryTrackSearch";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { mergeServiceCatalogResults } from "../serviceCatalogMerge";

interface UseSearchDataProps {
    query: string;
    libraryType?:
        | "all"
        | "artists"
        | "albums"
        | "tracks"
        | "audiobooks"
        | "podcasts";
    discoverType?: "music" | "podcasts" | "all";
    discoverScope?: "all" | "tracks" | "albums" | "artists";
    libraryLimit?: number;
    discoverLimit?: number;
    similarArtistsLimit?: number;
    source?: "all" | "local" | "peers";
}

interface UseSearchDataReturn {
    catalogNotice: string | null;
    libraryResults: SearchResult | null;
    discoverResults: DiscoverResult[];
    similarArtists: DiscoverResult[];
    aliasInfo: AliasInfo | null;
    isLibrarySearching: boolean;
    isDiscoverSearching: boolean;
    hasSearched: boolean;
    canRequestMoreDiscoverTracks: boolean;
    hasNextLibraryTracks: boolean;
    isFetchingNextLibraryTracks: boolean;
    fetchNextLibraryTracks: () => Promise<unknown>;
}

/**
 * Executes useSearchData.
 */
export function useSearchData({
    query,
    libraryType = "all",
    discoverType = "all",
    discoverScope = "all",
    libraryLimit = 20,
    discoverLimit = 20,
    similarArtistsLimit = 6,
    source = "all",
}: UseSearchDataProps): UseSearchDataReturn {
    const {
        data: libraryResults,
        isLoading: isLibrarySearching,
        isFetching: isLibraryFetching,
    } = useSearchQuery(
        query,
        libraryType,
        libraryLimit,
        source,
        libraryType !== "tracks",
    );
    const libraryTrackSearch = useLibraryTrackSearch(
        query,
        source,
        libraryType === "tracks",
    );

    const {
        data: discoverData,
        isLoading: isDiscoverSearching,
        isFetching: isDiscoverFetching,
    } = useDiscoverSearchQuery(
        query,
        discoverType,
        discoverLimit,
        discoverScope,
    );

    const serviceSearchEnabled =
        source === "all" &&
        discoverType !== "podcasts" &&
        (discoverScope === "all" || discoverScope === "tracks") &&
        query.trim().length >= 2 &&
        query.trim().length <= 200;
    const serviceCatalog = useQuery({
        queryKey: queryKeys.serviceCatalog(query.trim()),
        queryFn: ({ signal }) =>
            api.searchMusicSourceCatalog(query.trim(), signal),
        enabled: serviceSearchEnabled,
        staleTime: 60_000,
        retry: false,
    });
    const discoverResults = useMemo(
        () =>
            mergeServiceCatalogResults(
                discoverData?.results ?? [],
                serviceSearchEnabled ? (serviceCatalog.data?.tracks ?? []) : [],
            ),
        [discoverData, serviceCatalog.data, serviceSearchEnabled],
    );

    const aliasInfo = useMemo(() => {
        return discoverData?.aliasInfo || null;
    }, [discoverData]);
    const effectiveLibraryResults = useMemo<SearchResult | undefined>(() => {
        if (libraryType !== "tracks") {
            return libraryResults as SearchResult | undefined;
        }
        return { tracks: libraryTrackSearch.tracks };
    }, [libraryResults, libraryTrackSearch.tracks, libraryType]);

    // Derive top artist for the similar artists query, using the same
    // exact-match-aware selection the search page shows as the top result.
    const topArtist = useMemo(() => {
        const selection = deriveDiscoverySelection({
            discoverResults,
            query,
            aliasCanonical: aliasInfo?.canonical,
            libraryTopName: null,
            showDiscover: true,
        });
        const seed = selection.topArtist;
        return seed ? { name: seed.name, mbid: seed.mbid || "" } : null;
    }, [discoverResults, query, aliasInfo]);

    // Separate query for similar artists -- fires after discover results load
    const { data: similarData } = useDiscoverSimilarArtistsQuery(
        topArtist?.name || "",
        topArtist?.mbid || "",
        similarArtistsLimit,
    );

    const similarArtists = useMemo(() => {
        return similarData?.similarArtists || [];
    }, [similarData]);

    const hasSearched = query.trim().length >= 2;

    return {
        catalogNotice:
            serviceSearchEnabled && serviceCatalog.isError
                ? "VK и Яндекс сейчас недоступны. Показаны результаты остальных каталогов."
                : serviceSearchEnabled &&
                    serviceCatalog.data?.unavailable.length
                  ? `${serviceCatalog.data.unavailable.map((source) => (source === "vk" ? "VK" : "Яндекс")).join(" и ")} сейчас недоступны. Показаны результаты остальных каталогов.`
                  : null,
        libraryResults: effectiveLibraryResults || null,
        discoverResults,
        similarArtists,
        aliasInfo,
        isLibrarySearching:
            libraryType === "tracks"
                ? libraryTrackSearch.isLoading
                : isLibrarySearching || isLibraryFetching,
        isDiscoverSearching:
            isDiscoverSearching ||
            isDiscoverFetching ||
            (serviceSearchEnabled && serviceCatalog.isFetching),
        hasSearched,
        canRequestMoreDiscoverTracks: Boolean(
            discoverData?.pageInfo?.canRequestMoreTracks,
        ),
        hasNextLibraryTracks: Boolean(libraryTrackSearch.hasNextPage),
        isFetchingNextLibraryTracks: libraryTrackSearch.isFetchingNextPage,
        fetchNextLibraryTracks: libraryTrackSearch.fetchNextPage,
    };
}
