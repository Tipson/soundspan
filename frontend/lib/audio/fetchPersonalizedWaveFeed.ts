import { api } from "@/lib/api";
import { toProviderPlaybackTrack } from "./providerRadioContinuation";
import { requestOrderedWaveFeed } from "./orderedWaveRequest";
import type { OrderedWaveResetBudget } from "./orderedWaveRequest";
import type {
    OrderedWaveCheckpoint,
    OrderedWaveOwner,
} from "./orderedWaveSequence";
import { getRecommendationSessionId } from "../recommendationSession";
import type {
    PersonalizedHomeMode,
    PersonalizedHomeMood,
    PersonalizedHomeLanguage,
} from "@/features/home/types";
import {
    PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
    PERSONALIZED_HOME_TIMEOUT_RETRY,
} from "@/features/home/personalizedHomeRequestPolicy";

/** Auth-scoped identity for the current personal listening intent. */
export function orderedWaveOwner(
    mode: PersonalizedHomeMode,
    mood: PersonalizedHomeMood | null,
    language: PersonalizedHomeLanguage = "any",
): OrderedWaveOwner {
    return {
        authGeneration: api.getSessionGeneration(),
        sessionId: getRecommendationSessionId(),
        intent: JSON.stringify([mode, mood, language]),
    };
}

/** All capability and feed I/O remains within the existing API boundary. */
export function fetchPersonalizedWaveFeed(
    path: string,
    options?: {
        signal?: AbortSignal;
        checkpoint?: OrderedWaveCheckpoint;
        resetBudget?: OrderedWaveResetBudget;
    },
) {
    const owner = api.getSessionGeneration();
    const assertOwner = () => {
        if (api.getSessionGeneration() !== owner)
            throw new Error("Wave request owner changed");
    };
    return requestOrderedWaveFeed(
        {
            getOwner: () => api.getSessionGeneration(),
            ...(typeof api.getFeatures === "function"
                ? {
                      capabilities: () =>
                          api.getFeatures({
                              signal: options?.signal,
                              cache: "no-store",
                              timeoutMs: 1500,
                              retryOnTimeout: false,
                              _assertSession: assertOwner,
                          }),
                  }
                : {}),
            request: (path) =>
                api.request(path, {
                    method: "GET",
                    signal: options?.signal,
                    timeoutMs: PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
                    retryOnTimeout: PERSONALIZED_HOME_TIMEOUT_RETRY,
                    _assertSession: assertOwner,
                }),
        },
        path,
        options?.checkpoint,
        options?.resetBudget,
    ).then((receipt) => {
        if (receipt.page)
            for (const { track } of receipt.page.items)
                toProviderPlaybackTrack(track);
        return receipt;
    });
}
