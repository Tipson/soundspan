import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { PersonalizedHomeFeed } from "../types";

export const PERSONALIZED_HOME_REQUEST_TIMEOUT_MS = 17_000;
export const PERSONALIZED_HOME_TIMEOUT_RETRY = false;
export const PERSONALIZED_HOME_QUERY_RETRY = false;

/** Fetches Soundspan's provider-neutral personal shelves for one user. */
export function usePersonalizedHomeFeed(limit = 12, enabled = true) {
    return useQuery({
        queryKey: queryKeys.personalizedHome(limit),
        queryFn: ({ signal }) =>
            api.request<PersonalizedHomeFeed>(
                `/personalized/home?limit=${limit}`,
                {
                    method: "GET",
                    signal,
                    timeoutMs: PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
                    retryOnTimeout: PERSONALIZED_HOME_TIMEOUT_RETRY,
                },
            ),
        enabled,
        staleTime: 5 * 60 * 1000,
        retry: PERSONALIZED_HOME_QUERY_RETRY,
    });
}
