import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Track } from "@/lib/audio-state-context";
import { getListenTogetherSessionSnapshot } from "@/lib/listen-together-session";
import type { PlaybackAdvanceOrigin } from "@/lib/audio-engine/playbackAdvanceOrigin";
import { logPlaybackClientMetric } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import {
    shouldAutoMatchVibeAtQueueEnd,
    type AutoMatchVibeRequestResult,
} from "../autoMatchVibePlayback";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

interface UseQueueRecoveryEffectsOptions {
    refs: PlaybackOrchestratorRefs;
    playbackType: "track" | "audiobook" | "podcast" | null;
    queue: readonly unknown[];
    queueLength: number;
    currentIndex: number;
    isShuffle: boolean;
    shuffleIndices: readonly number[];
    repeatMode: "off" | "one" | "all";
    currentTrack: Track | null;
    requestAutoMatchVibe: (
        seedTrackId: string | null,
        options?: { force?: boolean },
    ) => Promise<AutoMatchVibeRequestResult>;
    advanceQueue: (origin: PlaybackAdvanceOrigin) => void;
    clearPendingTrackErrorSkip: () => void;
    clearStartupPlaybackRecovery: () => void;
    clearTransientTrackRecovery: (resetAttempts?: boolean) => void;
}

/** Preserves queue-end auto-match and pending recovery cleanup effects. */
export function useQueueRecoveryEffects({
    refs,
    playbackType,
    queue,
    queueLength,
    currentIndex,
    isShuffle,
    shuffleIndices,
    repeatMode,
    currentTrack,
    requestAutoMatchVibe,
    advanceQueue,
    clearPendingTrackErrorSkip,
    clearStartupPlaybackRecovery,
    clearTransientTrackRecovery,
}: UseQueueRecoveryEffectsOptions): (viaWatchdog: boolean) => boolean {
    const {
        advancePlayIntentAtMsRef,
        pendingAutoMatchAdvanceRef,
        pendingTrackErrorTrackIdRef,
    } = refs;
    const latestAdvanceQueueRef = useRef(advanceQueue);
    // Track the selected queue occurrence, not only its track ID: duplicate
    // entries may share an ID while representing different playback positions.
    const playbackPositionRef = useRef({
        currentIndex,
        queueItem: queue[currentIndex],
        generation: 0,
    });

    useEffect(() => {
        latestAdvanceQueueRef.current = advanceQueue;
    }, [advanceQueue]);

    useEffect(
        () => () => {
            pendingAutoMatchAdvanceRef.current = null;
        },
        [pendingAutoMatchAdvanceRef],
    );

    useLayoutEffect(() => {
        const previous = playbackPositionRef.current;
        const queueItem = queue[currentIndex];
        if (
            previous.currentIndex === currentIndex &&
            previous.queueItem === queueItem
        ) {
            return;
        }

        playbackPositionRef.current = {
            currentIndex,
            queueItem,
            generation: previous.generation + 1,
        };
    }, [currentIndex, queue]);

    const advancePendingQueue = useCallback(
        (pending: NonNullable<typeof pendingAutoMatchAdvanceRef.current>) => {
            if (pendingAutoMatchAdvanceRef.current !== pending) return;
            if (refs.currentTrackRef.current?.id !== pending.trackId) {
                pendingAutoMatchAdvanceRef.current = null;
                return;
            }
            if (
                playbackPositionRef.current.generation !==
                pending.playbackPositionGeneration
            ) {
                pendingAutoMatchAdvanceRef.current = null;
                return;
            }

            pendingAutoMatchAdvanceRef.current = null;
            advancePlayIntentAtMsRef.current = Date.now();
            logPlaybackClientMetric("player.track_end_advanced", {
                trackId: pending.trackId,
                viaWatchdog: pending.viaWatchdog,
            });
            latestAdvanceQueueRef.current(null);
        },
        [
            advancePlayIntentAtMsRef,
            pendingAutoMatchAdvanceRef,
            refs.currentTrackRef,
        ],
    );

    const advancePendingAutoMatch = useCallback(
        (pending: NonNullable<typeof pendingAutoMatchAdvanceRef.current>) => {
            if (!pending.requestSucceeded || !pending.queueChanged) return;
            advancePendingQueue(pending);
        },
        [advancePendingQueue, pendingAutoMatchAdvanceRef],
    );

    useEffect(() => {
        const pending = pendingAutoMatchAdvanceRef.current;
        if (!pending) return;
        if (currentTrack?.id !== pending.trackId) {
            pendingAutoMatchAdvanceRef.current = null;
            return;
        }
        if (queue === pending.queueIdentity) {
            if (
                playbackPositionRef.current.generation !==
                pending.playbackPositionGeneration
            ) {
                pendingAutoMatchAdvanceRef.current = null;
            }
            return;
        }

        pending.queueChanged = true;
        if (pending.requestSucceeded && pending.allowPlaybackPositionRemap) {
            // Audio-DNA intentionally replaces the queue and moves its seed to
            // index zero. Adopt that committed remap only for a successful request.
            pending.playbackPositionGeneration =
                playbackPositionRef.current.generation;
        }
        advancePendingAutoMatch(pending);
    }, [
        advancePendingAutoMatch,
        currentIndex,
        currentTrack?.id,
        pendingAutoMatchAdvanceRef,
        queue,
    ]);

    const shouldContinueAtQueueEnd = useCallback(
        () =>
            shouldAutoMatchVibeAtQueueEnd({
                playbackType,
                queueLength,
                currentIndex,
                isShuffle,
                shuffleIndices,
                repeatMode,
                isListenTogether: Boolean(
                    getListenTogetherSessionSnapshot()?.groupId,
                ),
            }),
        [
            playbackType,
            queueLength,
            currentIndex,
            isShuffle,
            shuffleIndices,
            repeatMode,
        ],
    );

    useEffect(() => {
        if (!shouldContinueAtQueueEnd() || !currentTrack?.id) {
            return;
        }

        void requestAutoMatchVibe(currentTrack.id);
    }, [currentTrack?.id, requestAutoMatchVibe, shouldContinueAtQueueEnd]);

    const continueQueueAfterAutoMatch = useCallback(
        (viaWatchdog: boolean): boolean => {
            const trackId = currentTrack?.id;
            if (!trackId || !shouldContinueAtQueueEnd()) return false;

            const pendingAdvance = {
                trackId,
                queueIdentity: queue,
                playbackPositionGeneration:
                    playbackPositionRef.current.generation,
                viaWatchdog,
                queueChanged: false,
                requestSucceeded: false,
                allowPlaybackPositionRemap: false,
            };
            pendingAutoMatchAdvanceRef.current = pendingAdvance;
            void requestAutoMatchVibe(trackId, { force: true }).then(
                (result) => {
                    if (refs.currentTrackRef.current?.id !== trackId) {
                        if (
                            pendingAutoMatchAdvanceRef.current ===
                            pendingAdvance
                        ) {
                            pendingAutoMatchAdvanceRef.current = null;
                        }
                        return;
                    }
                    if (pendingAutoMatchAdvanceRef.current !== pendingAdvance)
                        return;
                    if (!result.didExtendQueue) {
                        advancePendingQueue(pendingAdvance);
                        return;
                    }
                    if (
                        !pendingAdvance.queueChanged &&
                        result.queueMutation !== "replace" &&
                        playbackPositionRef.current.generation !==
                            pendingAdvance.playbackPositionGeneration
                    ) {
                        pendingAutoMatchAdvanceRef.current = null;
                        return;
                    }

                    pendingAdvance.requestSucceeded = true;
                    pendingAdvance.allowPlaybackPositionRemap =
                        result.queueMutation === "replace";
                    if (
                        pendingAdvance.queueChanged &&
                        pendingAdvance.allowPlaybackPositionRemap
                    ) {
                        pendingAdvance.playbackPositionGeneration =
                            playbackPositionRef.current.generation;
                    }
                    advancePendingAutoMatch(pendingAdvance);
                },
            );
            return true;
        },
        [
            currentTrack?.id,
            advancePendingAutoMatch,
            advancePendingQueue,
            pendingAutoMatchAdvanceRef,
            queue,
            refs.currentTrackRef,
            requestAutoMatchVibe,
            shouldContinueAtQueueEnd,
        ],
    );

    useEffect(() => {
        if (playbackType !== "track") {
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);
            return;
        }

        if (
            pendingTrackErrorTrackIdRef.current &&
            pendingTrackErrorTrackIdRef.current !== currentTrack?.id
        ) {
            clearPendingTrackErrorSkip();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        playbackType,
        currentTrack?.id,
        clearPendingTrackErrorSkip,
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
    ]);

    return continueQueueAfterAutoMatch;
}
