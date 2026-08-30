import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Track } from "../types";

/** Number of artist tracks requested in each bounded library page. */
export const ARTIST_TRACKS_PAGE_SIZE = 100;

interface ArtistTracksPage {
    tracks: Track[];
    total: number;
    offset: number;
    limit: number;
}

/** Fetch paginated library tracks for the dedicated artist Tracks view. */
export function useArtistTracks(
    artistId: string | undefined,
    enabled: boolean,
) {
    const query = useInfiniteQuery<
        ArtistTracksPage,
        Error,
        { pages: ArtistTracksPage[]; pageParams: number[] },
        readonly unknown[],
        number
    >({
        queryKey: queryKeys.artistTracks(artistId ?? ""),
        queryFn: async ({ pageParam }) => {
            if (!artistId) throw new Error("Artist ID is required");
            const response = await api.getArtistTracks(artistId, {
                limit: ARTIST_TRACKS_PAGE_SIZE,
                offset: pageParam,
            });
            return {
                tracks: response.tracks as Track[],
                total: response.total,
                offset: response.offset,
                limit: response.limit,
            };
        },
        initialPageParam: 0,
        getNextPageParam: (lastPage) => {
            if (lastPage.tracks.length === 0) return undefined;
            const nextOffset = lastPage.offset + lastPage.tracks.length;
            return nextOffset < lastPage.total ? nextOffset : undefined;
        },
        enabled: enabled && Boolean(artistId),
        staleTime: 2 * 60 * 1000,
    });
    const tracks = query.data?.pages.flatMap((page) => page.tracks) ?? [];
    const total = query.data?.pages[0]?.total ?? 0;

    return { ...query, tracks, total };
}
