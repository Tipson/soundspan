import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { playbackStateMachine } from "@/lib/audio";
import type { Track } from "@/lib/audio-state-context";
import type { QueueItem } from "@/lib/queue-item";
import { isListenTogetherActiveOrPending } from "@/lib/listen-together-session";
import {
    createUnavailableYtMusicRecoveryCoordinator,
    type UnavailableYtMusicRecoveryOutcome,
    type UnavailableYtMusicRecoveryResponse,
} from "@/lib/audio/unavailableYtMusicRecovery";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { usePlaybackRecoveryHelpers } from "./usePlaybackRecoveryHelpers";

type StateSetter<T> = (value: T | ((previous: T) => T)) => void;
type Replacement = Extract<
    UnavailableYtMusicRecoveryResponse,
    { status: "replaced" }
>["replacement"];

interface UseUnavailableYtMusicRecoveryOptions {
    refs: PlaybackOrchestratorRefs;
    playbackRecoveryHelpers: ReturnType<typeof usePlaybackRecoveryHelpers>;
    setCurrentTrack: StateSetter<Track | null>;
    setQueue: StateSetter<QueueItem[]>;
    setIsBuffering: (isBuffering: boolean) => void;
}

function replaceProviderIdentity(
    track: Track,
    replacement: Replacement,
): Track {
    return {
        ...track,
        youtubeVideoId: replacement.videoId,
        ...(track.provider
            ? {
                  provider: {
                      ...track.provider,
                      source: "youtube",
                      providerTrackId: replacement.videoId,
                      youtubeVideoId: replacement.videoId,
                  },
              }
            : {}),
        ...(replacement.trackYtMusicId
            ? { trackYtMusicId: replacement.trackYtMusicId }
            : {}),
    };
}

function isSameProviderOccurrence(
    candidate: Track,
    expectedTrack: Track,
): boolean {
    return (
        (expectedTrack.playlistItemId
            ? candidate.playlistItemId === expectedTrack.playlistItemId
            : candidate.id === expectedTrack.id) &&
        candidate.youtubeVideoId === expectedTrack.youtubeVideoId
    );
}

/** Owns correlated, singleflight provider replacement for the player. */
export function useUnavailableYtMusicRecovery({
    refs,
    playbackRecoveryHelpers,
    setCurrentTrack,
    setQueue,
    setIsBuffering,
}: UseUnavailableYtMusicRecoveryOptions) {
    const mountedRef = useRef(true);
    const unavailableYtMusicRecoveryInFlightRef = useRef(false);
    const {
        currentTrackRef,
        lastTrackIdRef,
        isLoadingRef,
        advancePlayIntentAtMsRef,
    } = refs;
    const { clearPendingTrackErrorSkip, clearTransientTrackRecovery } =
        playbackRecoveryHelpers;

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const coordinatorRef = useRef<ReturnType<
        typeof createUnavailableYtMusicRecoveryCoordinator
    > | null>(null);
    const getCoordinator = useCallback(() => {
        if (!coordinatorRef.current) {
            coordinatorRef.current =
                createUnavailableYtMusicRecoveryCoordinator({
                    request: (input) =>
                        api.recoverUnavailableYtMusicTrack(input),
                    getCurrentTrack: () => currentTrackRef.current,
                    isActive: () => mountedRef.current,
                    applyReplacement: (expectedTrack, replacement) => {
                        clearPendingTrackErrorSkip();
                        clearTransientTrackRecovery(true);
                        lastTrackIdRef.current = null;
                        isLoadingRef.current = false;
                        advancePlayIntentAtMsRef.current = Date.now();
                        playbackStateMachine.forceTransition("LOADING");
                        setIsBuffering(true);
                        setQueue((items) =>
                            items.map((item) =>
                                item.itemType !== "episode" &&
                                isSameProviderOccurrence(item, expectedTrack)
                                    ? replaceProviderIdentity(item, replacement)
                                    : item,
                            ),
                        );
                        setCurrentTrack((activeTrack) =>
                            activeTrack &&
                            isSameProviderOccurrence(
                                activeTrack,
                                expectedTrack,
                            )
                                ? replaceProviderIdentity(
                                      activeTrack,
                                      replacement,
                                  )
                                : activeTrack,
                        );
                    },
                });
        }
        return coordinatorRef.current;
    }, [
        advancePlayIntentAtMsRef,
        clearPendingTrackErrorSkip,
        clearTransientTrackRecovery,
        currentTrackRef,
        isLoadingRef,
        lastTrackIdRef,
        setCurrentTrack,
        setIsBuffering,
        setQueue,
    ]);

    const attemptUnavailableYtMusicRecovery = useCallback(
        async (
            track: Track | null,
        ): Promise<UnavailableYtMusicRecoveryOutcome> => {
            if (
                !track ||
                track.streamSource !== "youtube" ||
                !track.youtubeVideoId ||
                isListenTogetherActiveOrPending()
            ) {
                return "not_applicable";
            }
            unavailableYtMusicRecoveryInFlightRef.current = true;
            playbackStateMachine.forceTransition("LOADING");
            setIsBuffering(true);
            try {
                return await getCoordinator().recover(track);
            } finally {
                unavailableYtMusicRecoveryInFlightRef.current = false;
            }
        },
        [getCoordinator, setIsBuffering],
    );

    return {
        attemptUnavailableYtMusicRecovery,
        unavailableYtMusicRecoveryInFlightRef,
    };
}
