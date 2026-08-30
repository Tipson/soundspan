"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type LibraryHealthSummary } from "@/lib/api";
import { libraryOperationsRu } from "@/lib/i18n/libraryOperationsRu";
import { userFacingError } from "@/lib/i18n/ru";

export interface LibraryInsightsState {
    summary: LibraryHealthSummary | null;
    isLoading: boolean;
    isRefreshing: boolean;
    error: string | null;
    refresh: () => void;
    /** Increments when a cache-busting refresh succeeds; expanded panels reload on change. */
    refreshToken: number;
}

/** Loads the cached dashboard summary and exposes a cache-busting refresh. */
export function useLibraryInsights(): LibraryInsightsState {
    const [summary, setSummary] = useState<LibraryHealthSummary | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [refreshToken, setRefreshToken] = useState(0);

    useEffect(() => {
        let cancelled = false;
        void api
            .getLibraryHealthSummary()
            .then((data) => {
                if (!cancelled) setSummary(data);
            })
            .catch((loadError: unknown) => {
                if (!cancelled) {
                    setError(
                        userFacingError(
                            loadError,
                            libraryOperationsRu.libraryInsights.loadFailed,
                        ),
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const refresh = useCallback(() => {
        setIsRefreshing(true);
        setError(null);
        void api
            .refreshLibraryHealthDashboard()
            .then((data) => {
                setSummary(data);
                setRefreshToken((token) => token + 1);
            })
            .catch((refreshError: unknown) => {
                setError(
                    userFacingError(
                        refreshError,
                        libraryOperationsRu.libraryInsights.refreshFailed,
                    ),
                );
            })
            .finally(() => {
                setIsRefreshing(false);
            });
    }, []);

    return { summary, isLoading, isRefreshing, error, refresh, refreshToken };
}
