import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import { ArtistSource } from "../types";
import { useMemo, useEffect, useRef, useState, useCallback } from "react";
import {
    normalizeYtMusicArtist,
    normalizeYtMusicChannelId,
} from "../ytMusicArtist";

/**
 * Executes useArtistData.
 */
export function useArtistData() {
    const params = useParams();
    const id = params.id as string;
    const searchParams = useSearchParams();
    const providerChannelId = normalizeYtMusicChannelId(
        searchParams.get("channelId"),
    );
    const isYtMusicArtist =
        searchParams.get("provider") === "ytmusic" && !!providerChannelId;
    const fallbackArtistName = useMemo(() => {
        try {
            return decodeURIComponent(id || "");
        } catch {
            return id || "YouTube Music artist";
        }
    }, [id]);
    const { downloadStatus } = useDownloadContext();
    const prevActiveCountRef = useRef(downloadStatus.activeDownloads.length);
    const retryCountRef = useRef(0);
    const MAX_DISCOGRAPHY_RETRIES = 3;

    // Heuristic used across the app: local DB IDs do not contain hyphens.
    // For these IDs we can fetch a fast "core" payload first.
    const shouldUseLightweightCore = Boolean(
        id && !isYtMusicArtist && !id.includes("-"),
    );

    const {
        data: providerArtistData,
        isLoading: isProviderLoading,
        isError: isProviderError,
        refetch: refetchProvider,
    } = useQuery({
        queryKey: queryKeys.ytMusicArtist(providerChannelId || ""),
        queryFn: async () => {
            if (!providerChannelId) {
                throw new Error("YouTube Music channel ID is required");
            }
            const payload = await api.getYtMusicArtist(providerChannelId);
            return normalizeYtMusicArtist(payload, {
                channelId: providerChannelId,
                fallbackName: fallbackArtistName,
            });
        },
        enabled: isYtMusicArtist,
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });

    const {
        data: coreArtist,
        isLoading: isCoreLoading,
        isError: isCoreError,
        refetch: refetchCore,
    } = useQuery({
        queryKey: queryKeys.artist(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Artist ID is required");

            try {
                if (shouldUseLightweightCore) {
                    return await api.getArtist(id, {
                        includeDiscography: false,
                        includeTopTracks: false,
                        includeSimilarArtists: false,
                    });
                }
                return await api.getArtist(id);
            } catch {
                return await api.getArtistDiscovery(id, {
                    includeDiscography: false,
                    includeTopTracks: false,
                    includeSimilarArtists: false,
                });
            }
        },
        enabled: !!id && !isYtMusicArtist,
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });

    const coreSource: ArtistSource | null = useMemo(() => {
        if (isYtMusicArtist && providerArtistData?.artist) {
            return "discovery";
        }
        if (!coreArtist) return null;
        return coreArtist.id && !coreArtist.id.includes("-")
            ? "library"
            : "discovery";
    }, [coreArtist, isYtMusicArtist, providerArtistData]);

    const shouldHydrateDetails =
        !isYtMusicArtist &&
        !!id &&
        !!coreArtist &&
        ((coreSource === "library" && shouldUseLightweightCore) ||
            coreSource === "discovery");

    const {
        data: detailedArtist,
        isLoading: isDetailsLoading,
        isFetching: isDetailsFetching,
        refetch: refetchDetails,
    } = useQuery({
        queryKey: queryKeys.artistDetails(id || "", coreSource),
        queryFn: async () => {
            if (!id) throw new Error("Artist ID is required");
            if (coreSource === "library") {
                return await api.getArtist(id);
            }
            if (coreSource === "discovery") {
                return await api.getArtistDiscovery(id);
            }
            throw new Error("Artist source is required");
        },
        enabled: shouldHydrateDetails,
        staleTime: (query) => {
            const data = query.state.data as
                | { discographyComplete?: boolean }
                | undefined;
            if (data?.discographyComplete === false) return 0;
            return 10 * 60 * 1000;
        },
        retry: 1,
    });

    const artist = isYtMusicArtist
        ? providerArtistData?.artist
        : detailedArtist || coreArtist;

    const detailsLoading =
        shouldHydrateDetails &&
        !detailedArtist &&
        (isDetailsLoading || isDetailsFetching);

    // If discography was incomplete (MusicBrainz failed), automatically retry
    // with exponential backoff up to MAX_DISCOGRAPHY_RETRIES times.
    useEffect(() => {
        if (!detailedArtist || !shouldHydrateDetails) return;

        if (
            detailedArtist.discographyComplete === false &&
            retryCountRef.current < MAX_DISCOGRAPHY_RETRIES
        ) {
            const delay = Math.min(
                2000 * Math.pow(2, retryCountRef.current),
                10000,
            );
            const timeoutId = setTimeout(() => {
                retryCountRef.current += 1;
                void refetchDetails();
            }, delay);
            return () => clearTimeout(timeoutId);
        }

        if (detailedArtist.discographyComplete !== false) {
            retryCountRef.current = 0;
        }
    }, [detailedArtist, shouldHydrateDetails, refetchDetails]);

    // Reset retry counter when navigating to a different artist
    useEffect(() => {
        retryCountRef.current = 0;
    }, [id]);

    const reloadArtist = useCallback(async () => {
        if (isYtMusicArtist) {
            await refetchProvider();
            return;
        }
        await refetchCore();
        if (shouldHydrateDetails) {
            await refetchDetails();
        }
    }, [
        isYtMusicArtist,
        refetchCore,
        refetchDetails,
        refetchProvider,
        shouldHydrateDetails,
    ]);

    // Refetch when downloads complete (active count decreases)
    useEffect(() => {
        const currentActiveCount = downloadStatus.activeDownloads.length;
        if (
            prevActiveCountRef.current > 0 &&
            currentActiveCount < prevActiveCountRef.current
        ) {
            void reloadArtist();
        }
        prevActiveCountRef.current = currentActiveCount;
    }, [downloadStatus.activeDownloads.length, reloadArtist]);

    // Determine source from merged artist data (core or hydrated details)
    const source: ArtistSource | null = useMemo(() => {
        if (!artist) return null;
        if (isYtMusicArtist) return "discovery";
        return artist.id && !artist.id.includes("-") ? "library" : "discovery";
    }, [artist, isYtMusicArtist]);

    // Sort state: 'year' or 'dateAdded'
    const [sortBy, setSortBy] = useState<"year" | "dateAdded">("year");

    // Sort albums by year or dateAdded (auto-memoized by React Compiler)
    const albums = !artist?.albums
        ? []
        : [...artist.albums].sort((a, b) => {
              if (sortBy === "dateAdded") {
                  if (!a.lastSynced && !b.lastSynced) return 0;
                  if (!a.lastSynced) return 1;
                  if (!b.lastSynced) return -1;
                  return (
                      new Date(b.lastSynced).getTime() -
                      new Date(a.lastSynced).getTime()
                  );
              }

              if (a.year == null && b.year == null) return 0;
              if (a.year == null) return 1;
              if (b.year == null) return -1;
              return b.year - a.year;
          });

    return {
        artist,
        albums,
        providerAlbums: providerArtistData?.providerAlbums ?? [],
        artistProvider: isYtMusicArtist ? ("ytmusic" as const) : null,
        loading: isYtMusicArtist ? isProviderLoading : isCoreLoading,
        detailsLoading,
        error: isYtMusicArtist ? isProviderError : isCoreError,
        source,
        sortBy,
        setSortBy,
        reloadArtist,
    };
}
