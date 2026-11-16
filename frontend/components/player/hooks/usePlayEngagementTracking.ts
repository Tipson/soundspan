import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import type { Track, WaveMode } from "@/lib/audio-state-context";
import { frontendLogger } from "@/lib/logger";
import { isRemoteTrack } from "@/lib/trackRef";
import { toPlayTrackRef, type PlayTrackRef } from "@/lib/playTrackRef";
import type { PlayLogInput, PlayRecommendationContext } from "@/lib/api/plays";
import {
    createPlayEngagementTracker,
    resolvePlaybackRecommendationContext,
    resolvePlaybackRecommendationSessionId,
} from "./playEngagementSession";
import { getRecommendationSessionId } from "@/lib/recommendationSession";
import { getAuthRuntimeLease } from "@/lib/auth-runtime-generation";
import { createPlayJournalDeliveryScope } from "@/lib/playCreateJournalBridge";
import { resolvePlaybackOccurrenceMediaIdentity } from "@/lib/audio-engine/playbackOccurrence";
import { isListenTogetherActiveOrPending } from "@/lib/listen-together-session";
import { createPlayEngagementOccurrenceResolver } from "./playEngagementOccurrence";

const logger = frontendLogger.child("PlayEngagement");

interface UsePlayEngagementTrackingOptions {
    currentTrack: Track | null;
    currentIndex: number;
    localTrackPlaybackOccurrence: number;
    playbackType: "track" | "audiobook" | "podcast" | null;
    isCurrentEngineOccurrence(): boolean;
    vibeMode: boolean;
    waveMode: WaveMode;
}

function splitPlayInput(input: PlayLogInput): {
    trackRef: PlayTrackRef;
    context: PlayRecommendationContext;
} {
    const {
        playContext,
        waveMode,
        recommendationGenerationId,
        recommendationSessionId,
        ...trackRef
    } = input;
    return {
        trackRef: trackRef as PlayTrackRef,
        context: {
            ...(playContext ? { playContext } : {}),
            ...(waveMode ? { waveMode } : {}),
            ...(recommendationGenerationId
                ? { recommendationGenerationId }
                : {}),
            ...(recommendationSessionId ? { recommendationSessionId } : {}),
        },
    };
}

function remotePlayIdentity(
    track: Track | null,
): { recordingKey: string; rowKey: string } | null {
    if (!track || !isRemoteTrack(track)) return null;
    try {
        const ref = toPlayTrackRef(track);
        const mediaKey =
            "youtubeVideoId" in ref
                ? `youtube:${ref.youtubeVideoId}`
                : "tidalTrackId" in ref
                  ? `tidal:${ref.tidalTrackId}`
                  : "musicSourceRecording" in ref
                    ? `${ref.musicSourceRecording.provider}:${ref.musicSourceRecording.id}`
                    : `track:${ref.trackId}`;
        return {
            recordingKey: mediaKey,
            rowKey: resolvePlaybackOccurrenceMediaIdentity(track, mediaKey),
        };
    } catch {
        return null;
    }
}

/** Connects runtime playback events to one final recommendation signal. */
export function usePlayEngagementTracking({
    currentTrack,
    currentIndex,
    localTrackPlaybackOccurrence,
    playbackType,
    isCurrentEngineOccurrence,
    vibeMode,
    waveMode,
}: UsePlayEngagementTrackingOptions) {
    const trackerRef = useRef<
        ReturnType<typeof createPlayEngagementTracker> | undefined
    >(undefined);
    const authLeaseRef = useRef(getAuthRuntimeLease());
    const scopeRef = useRef<
        ReturnType<typeof createPlayJournalDeliveryScope> | undefined
    >(undefined);
    const occurrenceRef = useRef<
        ReturnType<typeof createPlayEngagementOccurrenceResolver> | undefined
    >(undefined);
    const getTracker = useCallback(() => {
        if (trackerRef.current) return trackerRef.current;
        const scope = createPlayJournalDeliveryScope(authLeaseRef.current);
        const occurrence = createPlayEngagementOccurrenceResolver();
        occurrenceRef.current = occurrence;
        scopeRef.current = scope;
        const tracker = createPlayEngagementTracker({
            beginPlay: (input) => {
                scope.assertCurrent();
                return occurrence.current().journal ? scope.begin(input) : null;
            },
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
    const identity =
        playbackType === "track" ? remotePlayIdentity(currentTrack) : null;
    const recordingKey = identity?.recordingKey ?? null;
    const rowKey = identity?.rowKey ?? null;
    const observeCurrentOccurrence = useCallback(() => {
        getTracker();
        return occurrenceRef.current!.observe({
            recordingKey,
            rowKey,
            localOccurrence: localTrackPlaybackOccurrence,
            currentIndex,
            collaborative: isListenTogetherActiveOrPending(),
        });
    }, [
        getTracker,
        recordingKey,
        rowKey,
        localTrackPlaybackOccurrence,
        currentIndex,
    ]);

    const startCurrentPlay = useCallback(() => {
        if (
            playbackType !== "track" ||
            !currentTrack ||
            !recordingKey ||
            !isRemoteTrack(currentTrack) ||
            !isCurrentEngineOccurrence()
        ) {
            return;
        }
        try {
            const occurrence = observeCurrentOccurrence();
            if (!occurrence.key) return;
            const context = resolvePlaybackRecommendationContext(
                typeof window === "undefined" ? null : window.location.pathname,
                vibeMode,
                waveMode,
            );
            getTracker().start({
                key: occurrence.key,
                play: {
                    ...toPlayTrackRef(currentTrack),
                    ...context,
                    recommendationSessionId:
                        resolvePlaybackRecommendationSessionId(
                            currentTrack.recommendationSessionId,
                            getRecommendationSessionId(),
                        ),
                    ...(currentTrack.recommendationGenerationId
                        ? {
                              recommendationGenerationId:
                                  currentTrack.recommendationGenerationId,
                          }
                        : {}),
                },
                durationSeconds: currentTrack.duration,
            });
        } catch (error) {
            logger.warn("Play engagement payload failed", {
                trackId: currentTrack.id,
                error,
            });
        }
    }, [
        currentTrack,
        getTracker,
        isCurrentEngineOccurrence,
        recordingKey,
        observeCurrentOccurrence,
        playbackType,
        vibeMode,
        waveMode,
    ]);

    useEffect(() => {
        const tracker = getTracker();
        tracker.transitionTo(observeCurrentOccurrence().key);
    }, [getTracker, observeCurrentOccurrence]);

    useEffect(() => {
        getTracker();
        const finalize = () => trackerRef.current?.transitionTo(null);
        const unregister = scopeRef.current?.registerFinalizer(finalize);
        return () => {
            finalize();
            unregister?.();
            trackerRef.current = undefined;
            scopeRef.current = undefined;
            occurrenceRef.current = undefined;
        };
    }, [getTracker]);

    const noteProgress = useCallback(
        (positionSeconds: number) => {
            if (!isCurrentEngineOccurrence()) return;
            startCurrentPlay();
            trackerRef.current?.noteProgress(positionSeconds);
        },
        [isCurrentEngineOccurrence, startCurrentPlay],
    );
    const finishCompleted = useCallback(() => {
        trackerRef.current?.finish("completed");
        occurrenceRef.current?.finish();
    }, []);
    const finishFailed = useCallback(() => {
        trackerRef.current?.finish("failed");
        occurrenceRef.current?.finish();
    }, []);

    return {
        startCurrentPlay,
        noteProgress,
        finishCompleted,
        finishFailed,
    };
}
