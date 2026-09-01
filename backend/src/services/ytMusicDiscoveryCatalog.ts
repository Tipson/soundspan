import type { CanonicalMediaSearchResult } from "@soundspan/media-metadata-contract";
import {
    isExplicitVideoSearchResult,
    toCanonicalSearchResultItem,
    toCatalogAlbumResultItem,
    toCatalogArtistResultItem,
    type YtMusicCatalogAlbumResult,
    type YtMusicCatalogArtistResult,
    type YtMusicSearchOptions,
} from "./youtubeMusic";

/** YouTube Music categories represented in one discovery batch. */
export type YtMusicDiscoveryCatalogFilter = "songs" | "albums" | "artists";

/** Normalized discovery results plus any category rows the sidecar could not serve. */
export interface YtMusicDiscoveryCatalogResponse {
    tracks: CanonicalMediaSearchResult[];
    albums: YtMusicCatalogAlbumResult[];
    artists: YtMusicCatalogArtistResult[];
    failedFilters: YtMusicDiscoveryCatalogFilter[];
}

interface YtMusicDiscoveryBatchRow {
    results: unknown[];
    total: number;
    error: string | null;
}

/** Minimal transport required to submit discovery as one sidecar batch admission. */
export interface YtMusicDiscoveryCatalogTransport {
    searchBatch(
        userId: string,
        queries: Array<{
            query: string;
            filter?: "songs" | "albums" | "artists" | "videos";
            limit?: number;
        }>,
        options?: YtMusicSearchOptions,
    ): Promise<YtMusicDiscoveryBatchRow[]>;
}

/**
 * Fetch and normalize tracks, albums, and artists through one queued sidecar
 * batch. Row-level failures remain explicit so callers can retain successful
 * categories without caching an incomplete discovery response.
 */
export async function searchYtMusicDiscoveryCatalog(
    transport: YtMusicDiscoveryCatalogTransport,
    userId: string,
    query: string,
    limit: number,
    options: YtMusicSearchOptions = {},
): Promise<YtMusicDiscoveryCatalogResponse> {
    const filters: YtMusicDiscoveryCatalogFilter[] = [
        "songs",
        "albums",
        "artists",
    ];
    const batchResult = await transport.searchBatch(
        userId,
        filters.map((filter) => ({
            query,
            filter,
            // Progressive search is a track concern. Do not turn a request
            // for the next songs prefix into hundreds of album/artist rows.
            limit: filter === "songs" ? limit : Math.min(limit, 50),
        })),
        options,
    );
    const rows = Array.isArray(batchResult) ? batchResult : [];
    const failedFilters: YtMusicDiscoveryCatalogFilter[] = [];
    const resultsFor = (filter: YtMusicDiscoveryCatalogFilter): unknown[] => {
        const row = rows[filters.indexOf(filter)];
        if (!row || row.error || !Array.isArray(row.results)) {
            failedFilters.push(filter);
            return [];
        }
        return row.results;
    };

    const tracks = resultsFor("songs")
        .filter((item) => !isExplicitVideoSearchResult(item))
        .map((item) => toCanonicalSearchResultItem(item))
        .filter((item): item is CanonicalMediaSearchResult => item !== null);
    const albums = resultsFor("albums")
        .map((item) => toCatalogAlbumResultItem(item))
        .filter((item): item is YtMusicCatalogAlbumResult => item !== null);
    const artists = resultsFor("artists")
        .map((item) => toCatalogArtistResultItem(item))
        .filter((item): item is YtMusicCatalogArtistResult => item !== null);

    return { tracks, albums, artists, failedFilters };
}
