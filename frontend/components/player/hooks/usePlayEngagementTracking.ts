import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import type { Track, WaveMode } from "@/lib/audio-state-context";
import { frontendLogger } from "@/lib/logger";
import {
    isRemoteTrack,
    toAddToPlaylistRef,
    type AddToPlaylistRef,
} from "@/lib/trackRef";
import type { PlayLogInput, PlayRecommendationContext } from "@/lib/api/plays";
import {
    createPlayEngagementTracker,
    resolvePlaybackRecommendationContext,
} from "./playEngagementSession";

const logger = frontendLogger.child("PlayEngagement");

interface UsePlayEngagementTrackingOptions {
    currentTrack: Track | null;
    currentIndex: number;
    playbackType: "track" | "audiobook" | "podcast" | null;
    isPlaying: boolean;
    isBuffering: boolean;
    vibeMode: boolean;
    waveMode: WaveMode;
}

function splitPlayInput(input: PlayLogInput): {
    trackRef: AddToPlaylistRef;
    context: PlayRecommendationContext;
} {
    const { playContext, waveMode, ...trackRef } = input;
    return {
        trackRef: trackRef as AddToPlaylistRef,
        context: {
            ...(playContext ? { playContext } : {}),
            ...(waveMode ? { waveMode } : {}),
        },
    };
}

function remotePlayKey(track: Track | null): string | null {
    if (!track || !isRemoteTrack(track)) return null;
    try {
        return JSON.stringify(toAddToPlaylistRef(track));
    } catch {
        return null;
    }
}

/** Connects runtime playback events to one final recommendation signal. */
export function usePlayEngagementTracking({
    currentTrack,
    currentIndex,
    playbackType,
    isPlaying,
    isBuffering,
    vibeMode,
    waveMode,
}: UsePlayEngagementTrackingOptions) {
    const trackerRef = useRef<
        ReturnType<typeof createPlayEngagementTracker> | undefined
    >(undefined);
    const getTracker = useCallback(() => {
        if (trackerRef.current) return trackerRef.current;
        const tracker = createPlayEngagementTracker({
            logPlay: (input) => {
                const { trackRef, context } = splitPlayInput(input);
                return api.logPlay(trackRef, context);
            },
            updatePlayEngagement: (playId, input) =>
                api.updatePlayEngagement(playId, input),
            onError: (stage, error) => {
                logger.warn(`Play engagement ${stage} failed`, { error });
            },
        });
        trackerRef.current = tracker;
        return tracker;
    }, []);
    const trackKey = remotePlayKey(currentTrack);
    const playKey = trackKey ? `${trackKey}\u0000${currentIndex}` : null;

    const startCurrentPlay = useCallback(() => {
        if (
            playbackType !== "track" ||
            !currentTrack ||
            !playKey ||
            !isRemoteTrack(currentTrack)
        ) {
            return;
        }
        try {
            const context = resolvePlaybackRecommendationContext(
                typeof window === "undefined" ? null : window.location.pathname,
                vibeMode,
                waveMode,
            );
            getTracker().start({
                key: playKey,
                play: {
                    ...toAddToPlaylistRef(currentTrack),
                    ...context,
                },
                durationSeconds: currentTrack.duration,
            });
        } catch (error) {
            logger.warn("Play engagement payload failed", {
                trackId: currentTrack.id,
                error,
            });
        }
    }, [currentTrack, getTracker, playKey, playbackType, vibeMode, waveMode]);

    useEffect(() => {
        const tracker = getTracker();
        tracker.transitionTo(playKey);
        if (isPlaying && !isBuffering) {
            startCurrentPlay();
        }
    }, [getTracker, isBuffering, isPlaying, playKey, startCurrentPlay]);

    useEffect(
        () => () => {
            trackerRef.current?.transitionTo(null);
        },
        [],
    );

    const noteProgress = useCallback((positionSeconds: number) => {
        trackerRef.current?.noteProgress(positionSeconds);
    }, []);
    const finishCompleted = useCallback(() => {
        trackerRef.current?.finish("completed");
    }, []);
    const finishFailed = useCallback(() => {
        trackerRef.current?.finish("failed");
    }, []);

    return {
        startCurrentPlay,
        noteProgress,
        finishCompleted,
        finishFailed,
    };
}
