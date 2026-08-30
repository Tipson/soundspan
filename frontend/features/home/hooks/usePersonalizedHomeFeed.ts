import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type {
    PersonalizedHomeFeed,
    PersonalizedHomeMode,
    PersonalizedHomeMood,
} from "../types";
import {
    PERSONALIZED_HOME_QUERY_RETRY,
    PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
    PERSONALIZED_HOME_TIMEOUT_RETRY,
} from "../personalizedHomeRequestPolicy";

export {
    PERSONALIZED_HOME_QUERY_RETRY,
    PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
    PERSONALIZED_HOME_TIMEOUT_RETRY,
} from "../personalizedHomeRequestPolicy";

export function buildPersonalizedHomeFeedUrl(
    limit: number,
    mode: PersonalizedHomeMode,
    mood: PersonalizedHomeMood | null = null,
): string {
    const params = new URLSearchParams({
        limit: String(limit),
        mode,
    });
    if (mood) params.set("mood", mood);
    return `/personalized/home?${params.toString()}`;
}

/** Fetches one server-ranked variant of Soundspan's personal shelves. */
export function usePersonalizedHomeFeed(
    limit = 12,
    enabled = true,
    mode: PersonalizedHomeMode = "for-you",
    mood: PersonalizedHomeMood | null = null,
) {
    return useQuery({
        queryKey: queryKeys.personalizedHome(limit, mode, mood),
        queryFn: ({ signal }) =>
            api.request<PersonalizedHomeFeed>(
                buildPersonalizedHomeFeedUrl(limit, mode, mood),
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
