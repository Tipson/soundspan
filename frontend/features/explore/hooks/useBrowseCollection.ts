"use client";

import { useState, useEffect } from "react";
import type { TidalBrowseCollection } from "@/features/explore/browseTrack";
import { userFacingError } from "@/lib/i18n/ru";

/**
 * Fetch state for a TIDAL browse collection page. Reloads when the id or
 * fetcher changes; stale responses are dropped via the isActive latch.
 */
export function useBrowseCollection(
    collectionId: string,
    fetchCollection: (id: string) => Promise<TidalBrowseCollection>,
    loadErrorFallback: string,
) {
    const [collection, setCollection] = useState<TidalBrowseCollection | null>(
        null,
    );
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let isActive = true;

        async function fetchData() {
            setIsLoading(true);
            setError(null);
            setCollection(null);

            try {
                const data = await fetchCollection(collectionId);
                if (isActive) {
                    setCollection(data);
                }
            } catch (fetchError) {
                const message = userFacingError(fetchError, loadErrorFallback);
                if (isActive) {
                    setError(message);
                }
            } finally {
                if (isActive) {
                    setIsLoading(false);
                }
            }
        }

        fetchData();

        return () => {
            isActive = false;
        };
    }, [collectionId, fetchCollection, loadErrorFallback]);

    return { collection, isLoading, error };
}
