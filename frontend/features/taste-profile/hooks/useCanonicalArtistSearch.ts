"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type MusicBrainzArtistSearchResult } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

const ARTIST_SEARCH_DEBOUNCE_MS = 250;

/** A provider-resolved artist identity suitable for a canonical taste label. */
export type CanonicalArtistSearchResult = MusicBrainzArtistSearchResult;

/** Debounced, cancellable MusicBrainz autocomplete via the shared API client. */
export function useCanonicalArtistSearch(rawQuery: string) {
    const normalizedQuery = rawQuery.trim();
    const [debouncedQuery, setDebouncedQuery] = useState("");

    useEffect(() => {
        if (normalizedQuery.length < 2) return;
        const timeoutId = window.setTimeout(
            () => setDebouncedQuery(normalizedQuery),
            ARTIST_SEARCH_DEBOUNCE_MS,
        );
        return () => window.clearTimeout(timeoutId);
    }, [normalizedQuery]);

    const activeQuery = normalizedQuery.length >= 2 ? debouncedQuery : "";
    const search = useQuery({
        queryKey: queryKeys.musicBrainzArtistSearch(activeQuery),
        queryFn: async ({ signal }) => {
            const response = await api.searchMusicBrainzArtists(
                activeQuery,
                signal,
            );
            const seen = new Set<string>();
            return response.artists.filter((artist) => {
                const mbid = artist.mbid.trim();
                const name = artist.name.trim();
                if (!mbid || !name || seen.has(mbid)) return false;
                seen.add(mbid);
                return true;
            });
        },
        enabled: activeQuery.length >= 2,
        staleTime: 5 * 60_000,
        retry: 1,
    });

    const isDebouncing =
        normalizedQuery.length >= 2 && activeQuery !== normalizedQuery;
    return {
        results: isDebouncing ? [] : (search.data ?? []),
        isSearching: isDebouncing || search.isFetching,
        error: isDebouncing ? null : search.error,
        hasQuery: normalizedQuery.length >= 2,
    };
}
