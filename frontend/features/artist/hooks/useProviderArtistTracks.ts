import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { DiscoverResult } from "@/features/search/types";
import {
    advanceProviderReleaseCount,
    mergeProviderAlbumTracks,
    type ProviderAlbumTrackPayload,
} from "../providerArtistTracks";

export const PROVIDER_ARTIST_RELEASE_BATCH_SIZE = 4;

/** Load a provider artist's release tracks in small, explicit album batches. */
export function useProviderArtistTracks(
    releases: DiscoverResult[],
    enabled: boolean,
) {
    const releaseIds = useMemo(
        () =>
            Array.from(
                new Set(
                    releases
                        .map((release) => release.browseId?.trim())
                        .filter((id): id is string => Boolean(id)),
                ),
            ),
        [releases],
    );
    const releaseKey = releaseIds.join("\u0000");
    const [releaseWindow, setReleaseWindow] = useState(() => ({
        key: releaseKey,
        count: Math.min(PROVIDER_ARTIST_RELEASE_BATCH_SIZE, releaseIds.length),
    }));
    const visibleReleaseCount =
        releaseWindow.key === releaseKey
            ? releaseWindow.count
            : Math.min(PROVIDER_ARTIST_RELEASE_BATCH_SIZE, releaseIds.length);

    const effectiveVisibleReleaseCount = Math.min(
        releaseIds.length,
        Math.max(
            visibleReleaseCount,
            Math.min(PROVIDER_ARTIST_RELEASE_BATCH_SIZE, releaseIds.length),
        ),
    );
    const visibleReleaseIds = releaseIds.slice(0, effectiveVisibleReleaseCount);
    const queries = useQueries({
        queries: visibleReleaseIds.map((browseId) => ({
            queryKey: queryKeys.ytMusicAlbum(browseId),
            queryFn: () => api.getYtMusicAlbum(browseId),
            enabled,
            staleTime: 30 * 60 * 1000,
            retry: 1,
        })),
    });
    const loadedAlbums = queries.flatMap((query) =>
        query.data ? [query.data as ProviderAlbumTrackPayload] : [],
    );

    return {
        tracks: mergeProviderAlbumTracks(loadedAlbums),
        isLoading:
            enabled &&
            queries.some((query) => query.isLoading || query.isFetching),
        failedReleaseCount: queries.filter((query) => query.isError).length,
        loadedReleaseCount: queries.filter(
            (query) => query.data || query.isError,
        ).length,
        totalReleaseCount: releaseIds.length,
        hasNextPage: effectiveVisibleReleaseCount < releaseIds.length,
        isFetchingNextPage:
            enabled && queries.some((query) => query.isFetching),
        fetchNextPage: () =>
            setReleaseWindow((current) => ({
                key: releaseKey,
                count: advanceProviderReleaseCount(
                    current.key === releaseKey
                        ? current.count
                        : Math.min(
                              PROVIDER_ARTIST_RELEASE_BATCH_SIZE,
                              releaseIds.length,
                          ),
                    releaseIds.length,
                    PROVIDER_ARTIST_RELEASE_BATCH_SIZE,
                ),
            })),
    };
}
