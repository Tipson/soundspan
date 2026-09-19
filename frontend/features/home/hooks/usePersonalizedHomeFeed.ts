import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type {
    PersonalizedHomeFeed,
    PersonalizedHomeMode,
    PersonalizedHomeMood,
    PersonalizedHomeLanguage,
    PersonalizedRecommendationSurface,
} from "../types";
import {
    appendRecommendationClientContext,
    getRecommendationClientContext,
    getRecommendationSessionId,
    type RecommendationClientContext,
} from "@/lib/recommendationSession";
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
    surface: PersonalizedRecommendationSurface = "home",
    sessionId = getRecommendationSessionId(),
    context: RecommendationClientContext | null = getRecommendationClientContext(),
    language: PersonalizedHomeLanguage = "any",
): string {
    const params = new URLSearchParams({
        limit: String(limit),
        mode,
        surface,
        sessionId,
    });
    if (mood) params.set("mood", mood);
    if (surface === "wave" && language !== "any")
        params.set("language", language);
    appendRecommendationClientContext(params, context);
    return `/personalized/home?${params.toString()}`;
}

/** Fetches one server-ranked variant of Soundspan's personal shelves. */
export function waveLanguageRefreshInterval(
    language: PersonalizedHomeLanguage,
    data: PersonalizedHomeFeed | undefined,
    completedRequests: number,
): number | false {
    if (
        language === "any" ||
        completedRequests >= 6 ||
        !data?.languageStatus?.pending
    )
        return false;
    if (Object.values(data.shelves).some((tracks) => tracks.length > 0))
        return false;
    return 5000;
}

/** Fetches one server-ranked variant; optional metadata polling stops once playable. */
export function usePersonalizedHomeFeed(
    limit = 12,
    enabled = true,
    mode: PersonalizedHomeMode = "for-you",
    mood: PersonalizedHomeMood | null = null,
    surface: PersonalizedRecommendationSurface = "home",
    language: PersonalizedHomeLanguage = "any",
) {
    return useQuery({
        queryKey: queryKeys.personalizedHome(
            limit,
            mode,
            mood,
            surface,
            language,
        ),
        queryFn: ({ signal }) =>
            api.request<PersonalizedHomeFeed>(
                buildPersonalizedHomeFeedUrl(
                    limit,
                    mode,
                    mood,
                    surface,
                    undefined,
                    undefined,
                    language,
                ),
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
        refetchInterval: (query) =>
            query.state.status === "error"
                ? false
                : waveLanguageRefreshInterval(
                      language,
                      query.state.data,
                      query.state.dataUpdateCount,
                  ),
    });
}
