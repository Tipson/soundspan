"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { Track, useAudioState } from "@/lib/audio-state-context";
import { isEpisodeQueueItem } from "@/lib/queue-item";
import {
    formatListenTogetherQueueAccepted,
    formatMatchVibeConfirmation,
    listenTogetherFeedbackRu,
} from "@/lib/i18n/listenDeviceRu";
import { userFacingError } from "@/lib/i18n/ru";
import { listenTogetherSocket } from "@/lib/listen-together-socket";
import type { ListenTogetherSessionSnapshot } from "@/lib/listen-together-session";
import { frontendLogger } from "@/lib/logger";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import type { PersonalizedHomeFeed } from "@/features/home/types";
import {
    PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
    PERSONALIZED_HOME_TIMEOUT_RETRY,
} from "@/features/home/personalizedHomeRequestPolicy";
import {
    buildProviderRadioContinuationPath,
    collectProviderRadioContinuation,
    isProviderRadioTrack,
} from "./providerRadioContinuation";
import type {
    VibeModeStartOptions,
    VibeModeStartResult,
    VibeQueueMutationKind,
} from "../audio-controls-types";

type AudioState = ReturnType<typeof useAudioState>;
const MAX_PROVIDER_CONTINUATION_PAGES = 2;

interface QueueMutationMessages {
    singleAccepted: string;
    multiAccepted: (acceptedCount: number) => string;
    noneAccepted?: string;
}

interface QueueMutationResult {
    acceptedCount: number;
    skippedCount: number;
    truncated: boolean;
}

interface UseVibeModeControlsOptions {
    state: AudioState;
    getActiveListenTogetherSession: () => ListenTogetherSessionSnapshot | null;
    showQueueMutationToasts: (
        result: QueueMutationResult,
        messages: QueueMutationMessages,
    ) => void;
}

export function useVibeModeControls({
    state,
    getActiveListenTogetherSession,
    showQueueMutationToasts,
}: UseVibeModeControlsOptions) {
    const requestGenerationRef = useRef(0);
    const providerRadioCursorRef = useRef(0);
    const playbackContextRef = useRef({
        track: state.currentTrack,
        trackId: state.currentTrack?.id ?? null,
        currentIndex: state.currentIndex,
        queue: state.queue,
        vibeMode: state.vibeMode,
        waveMode: state.waveMode,
        waveMood: state.waveMood,
    });

    useLayoutEffect(() => {
        playbackContextRef.current = {
            track: state.currentTrack,
            trackId: state.currentTrack?.id ?? null,
            currentIndex: state.currentIndex,
            queue: state.queue,
            vibeMode: state.vibeMode,
            waveMode: state.waveMode,
            waveMood: state.waveMood,
        };
    }, [
        state.currentIndex,
        state.currentTrack,
        state.queue,
        state.vibeMode,
        state.waveMode,
        state.waveMood,
    ]);

    const startVibeMode = useCallback(
        async (
            options?: VibeModeStartOptions,
        ): Promise<VibeModeStartResult> => {
            const currentTrack = state.currentTrack;
            if (!currentTrack?.id) {
                return { success: false, trackCount: 0 };
            }
            const requestGeneration = ++requestGenerationRef.current;
            const replaceUpcoming =
                options?.queueStrategy === "replace-upcoming";
            const requestContext = {
                trackId: currentTrack.id,
                currentIndex: state.currentIndex,
                queue: state.queue,
                waveMode: state.waveMode,
                waveMood: state.waveMood,
            };
            const requestIsCurrent = () => {
                const currentContext = playbackContextRef.current;
                if (requestGenerationRef.current !== requestGeneration) {
                    return false;
                }
                if (replaceUpcoming) {
                    return (
                        currentContext.vibeMode &&
                        currentContext.waveMode === requestContext.waveMode &&
                        currentContext.waveMood === requestContext.waveMood &&
                        Boolean(
                            currentContext.track &&
                            isProviderRadioTrack(currentContext.track),
                        )
                    );
                }
                return (
                    currentContext.trackId === requestContext.trackId &&
                    currentContext.currentIndex ===
                        requestContext.currentIndex &&
                    currentContext.queue === requestContext.queue
                );
            };
            const reportLocalQueueCommit = (
                mutation: VibeQueueMutationKind,
            ) => {
                const token = options?.queueCommitToken;
                if (!token) return;
                options.onLocalQueueCommit?.({ token, mutation });
            };

            try {
                if (isProviderRadioTrack(currentTrack)) {
                    if (!state.vibeMode) {
                        providerRadioCursorRef.current = 0;
                    }
                    let cursor = providerRadioCursorRef.current;
                    let feed: PersonalizedHomeFeed | null = null;
                    let continuation: Track[] = [];
                    for (
                        let attempt = 0;
                        attempt < MAX_PROVIDER_CONTINUATION_PAGES;
                        attempt += 1
                    ) {
                        feed = await api.request<PersonalizedHomeFeed>(
                            buildProviderRadioContinuationPath(
                                state.queue,
                                cursor,
                                25,
                                state.waveMode,
                                state.vibeMode ? state.waveMood : null,
                            ),
                            {
                                timeoutMs: PERSONALIZED_HOME_REQUEST_TIMEOUT_MS,
                                retryOnTimeout: PERSONALIZED_HOME_TIMEOUT_RETRY,
                            },
                        );
                        if (!requestIsCurrent()) {
                            return { success: false, trackCount: 0 };
                        }
                        continuation = collectProviderRadioContinuation(
                            feed,
                            replaceUpcoming
                                ? playbackContextRef.current.queue
                                : state.queue,
                            25,
                        );
                        cursor =
                            typeof feed.nextCursor === "number"
                                ? feed.nextCursor
                                : cursor + 1;
                        providerRadioCursorRef.current = cursor;
                        if (continuation.length > 0) break;
                    }
                    if (!feed || continuation.length === 0) {
                        return { success: false, trackCount: 0 };
                    }

                    const listenTogetherSession =
                        getActiveListenTogetherSession();
                    if (replaceUpcoming && listenTogetherSession) {
                        return { success: false, trackCount: 0 };
                    }
                    if (listenTogetherSession) {
                        if (typeof window !== "undefined") {
                            const confirmed = window.confirm(
                                formatMatchVibeConfirmation(
                                    continuation.length,
                                ),
                            );
                            if (!confirmed) {
                                toast.info(
                                    listenTogetherFeedbackRu.matchVibeCancelled,
                                );
                                return { success: false, trackCount: 0 };
                            }
                        }
                        const queueResult =
                            await listenTogetherSocket.addToQueue(
                                continuation.map(toAddToPlaylistRef),
                            );
                        showQueueMutationToasts(queueResult, {
                            singleAccepted:
                                formatListenTogetherQueueAccepted(1),
                            multiAccepted: (acceptedCount) =>
                                formatListenTogetherQueueAccepted(
                                    acceptedCount,
                                ),
                        });
                        return {
                            success: queueResult.acceptedCount > 0,
                            trackCount: queueResult.acceptedCount,
                        };
                    }

                    if (replaceUpcoming) {
                        const latestContext = playbackContextRef.current;
                        const freshContinuation =
                            collectProviderRadioContinuation(
                                feed,
                                latestContext.queue,
                                25,
                            );
                        if (freshContinuation.length === 0) {
                            return { success: false, trackCount: 0 };
                        }
                        const boundedCurrentIndex = Math.max(
                            0,
                            Math.min(
                                latestContext.currentIndex,
                                Math.max(0, latestContext.queue.length - 1),
                            ),
                        );
                        const history = latestContext.queue.slice(
                            0,
                            boundedCurrentIndex + 1,
                        );
                        const replacementQueue = [
                            ...history,
                            ...freshContinuation,
                        ];
                        const firstFreshTrack = freshContinuation[0];

                        state.setIsShuffle(false);
                        state.setShuffleIndices([]);
                        state.setVibeMode(true);
                        state.setVibeSourceFeatures(null);
                        state.setVibeQueueIds(
                            replacementQueue.map((track) => track.id),
                        );
                        state.setQueue(replacementQueue);
                        state.setCurrentAudiobook(null);
                        state.setCurrentPodcast(null);
                        state.setPlaybackType("track");
                        state.setCurrentTrack(firstFreshTrack);
                        state.setCurrentIndex(history.length);
                        reportLocalQueueCommit("replace-upcoming");
                        return {
                            success: true,
                            trackCount: freshContinuation.length,
                        };
                    }

                    reportLocalQueueCommit("append");
                    if (state.isShuffle) {
                        const continuationStartIndex = state.queue.length;
                        state.setShuffleIndices((previousIndices) => [
                            ...previousIndices,
                            ...continuation.map(
                                (_, offset) => continuationStartIndex + offset,
                            ),
                        ]);
                    }
                    state.setVibeMode(true);
                    state.setVibeSourceFeatures(null);
                    state.setVibeQueueIds([
                        currentTrack.id,
                        ...continuation.map((track) => track.id),
                    ]);
                    state.setQueue((previousQueue) => {
                        const freshContinuation =
                            collectProviderRadioContinuation(
                                feed,
                                previousQueue,
                                25,
                            );
                        return freshContinuation.length > 0
                            ? [...previousQueue, ...freshContinuation]
                            : previousQueue;
                    });
                    return { success: true, trackCount: continuation.length };
                }

                const response = await api.getVibeSimilarTracks(
                    currentTrack.id,
                    50,
                );
                if (!requestIsCurrent()) {
                    return { success: false, trackCount: 0 };
                }
                if (!response.tracks || response.tracks.length === 0) {
                    return { success: false, trackCount: 0 };
                }

                const listenTogetherSession = getActiveListenTogetherSession();
                if (listenTogetherSession) {
                    const queueIds = [
                        currentTrack.id,
                        ...response.tracks.map((track) => track.id),
                    ];
                    const uniqueQueueIds = Array.from(new Set(queueIds));
                    if (uniqueQueueIds.length === 0) {
                        return { success: false, trackCount: 0 };
                    }

                    if (typeof window !== "undefined") {
                        const confirmed = window.confirm(
                            formatMatchVibeConfirmation(uniqueQueueIds.length),
                        );
                        if (!confirmed) {
                            toast.info(
                                listenTogetherFeedbackRu.matchVibeCancelled,
                            );
                            return { success: false, trackCount: 0 };
                        }
                    }

                    const queueResult =
                        await listenTogetherSocket.addToQueue(uniqueQueueIds);
                    showQueueMutationToasts(queueResult, {
                        singleAccepted: formatListenTogetherQueueAccepted(1),
                        multiAccepted: (acceptedCount) =>
                            formatListenTogetherQueueAccepted(acceptedCount),
                    });
                    return {
                        success: queueResult.acceptedCount > 0,
                        trackCount: queueResult.acceptedCount,
                    };
                }

                reportLocalQueueCommit("replace");
                state.setIsShuffle(false);
                state.setShuffleIndices([]);
                const queueIds = [
                    currentTrack.id,
                    ...response.tracks.map((track) => track.id),
                ];
                const vibeTracks: Track[] = response.tracks.map((track) => ({
                    id: track.id,
                    title: track.title,
                    duration: track.duration,
                    artist: { name: track.artist.name, id: track.artist.id },
                    album: {
                        title: track.album.title,
                        coverArt: track.album.coverUrl || undefined,
                        id: track.album.id,
                    },
                    audioFeatures: track.audioFeatures,
                }));

                state.setVibeMode(true);
                state.setVibeSourceFeatures(
                    response.sourceFeatures ||
                        currentTrack.audioFeatures ||
                        null,
                );
                state.setVibeQueueIds(queueIds);
                state.setQueue((previousQueue) => {
                    const current = previousQueue[state.currentIndex];
                    const base =
                        current && !isEpisodeQueueItem(current)
                            ? current
                            : currentTrack;
                    const enriched = response.sourceFeatures
                        ? {
                              ...base,
                              audioFeatures: {
                                  ...base.audioFeatures,
                                  ...response.sourceFeatures,
                              },
                          }
                        : base;
                    return [enriched, ...vibeTracks];
                });
                state.setCurrentIndex(0);

                return { success: true, trackCount: response.tracks.length };
            } catch (error) {
                frontendLogger.error(
                    "[Vibe] Failed to get similar tracks:",
                    error,
                );
                toast.error(
                    userFacingError(
                        error,
                        listenTogetherFeedbackRu.matchVibeFailed,
                    ),
                );
                return { success: false, trackCount: 0 };
            }
        },
        [state, getActiveListenTogetherSession, showQueueMutationToasts],
    );

    const stopVibeMode = useCallback(() => {
        requestGenerationRef.current++;
        providerRadioCursorRef.current = 0;
        state.setVibeMode(false);
        state.setWaveMood(null);
        state.setVibeSourceFeatures(null);
        state.setVibeQueueIds([]);
    }, [state]);

    return { startVibeMode, stopVibeMode };
}
