import { useEffect } from "react";
import { HeartbeatMonitor, playbackStateMachine } from "@/lib/audio";
import {
    HEARTBEAT_BUFFER_TIMEOUT_MS,
    UNEXPECTED_STOP_STARTUP_GUARD_MS,
} from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { resolveBufferingRecoveryAction } from "@/lib/audio-engine/playbackRecoveryPolicy";
import {
    PlaybackInterruptionError,
    resolveDirectTrackSourceType,
} from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { useTrackRecovery } from "./useTrackRecovery";
import { isDevicePlaybackSourceUrl } from "./playbackSourceLeaseController";

interface UsePlaybackWatchdogsOptions {
    refs: PlaybackOrchestratorRefs;
    trackRecovery: Pick<
        ReturnType<typeof useTrackRecovery>,
        "attemptTransientTrackRecovery" | "scheduleStartupPlaybackRecovery"
    >;
    isPlaying: boolean;

    isBuffering: boolean;
    setIsBuffering: (isBuffering: boolean) => void;
    setIsPlaying: (isPlaying: boolean) => void;
    getPlaybackSourceUrl(): string | null;
}

/** Runs the existing heartbeat stall and unexpected-stop watchdogs. */
export function usePlaybackWatchdogs({
    refs,
    trackRecovery,
    isPlaying,
    isBuffering,
    setIsBuffering,
    setIsPlaying,
    getPlaybackSourceUrl,
}: UsePlaybackWatchdogsOptions): void {
    const { attemptTransientTrackRecovery, scheduleStartupPlaybackRecovery } =
        trackRecovery;
    const {
        heartbeatRef,
        currentTrackRef,
        playbackTypeRef,
        seekReloadInProgressRef,
        isLoadingRef,
        lastPlayingStateRef,
        startupStabilityRef,
        unexpectedStopStartupGuardRef,
    } = refs;

    // Initialize heartbeat monitor
    useEffect(() => {
        heartbeatRef.current = new HeartbeatMonitor(
            {
                onStall: () => {
                    // Playback stalled - time not moving while the engine reports playing
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Heartbeat detected stall",
                    );
                    logPlaybackClientMetric("player.rebuffer", {
                        reason: "heartbeat_stall",
                        trackId: currentTrackRef.current?.id ?? null,
                        sourceType: currentTrackRef.current
                            ? resolveDirectTrackSourceType(
                                  currentTrackRef.current,
                              )
                            : "unknown",
                    });
                    const transitionedToBuffering =
                        playbackStateMachine.transition("BUFFERING");
                    if (
                        !transitionedToBuffering &&
                        !playbackStateMachine.isBuffering
                    ) {
                        // Keep machine + React state aligned even after event-race transitions.
                        playbackStateMachine.forceTransition("BUFFERING");
                    }
                    setIsBuffering(true);
                    heartbeatRef.current?.startBufferTimeout();
                },
                onUnexpectedStop: () => {
                    // Engine stopped without an explicit stop/end event
                    const trackId = currentTrackRef.current?.id ?? null;
                    const handledEnd = refs.lastHandledTrackEndRef.current;
                    if (
                        playbackTypeRef.current === "track" &&
                        trackId !== null &&
                        handledEnd.trackId === trackId &&
                        handledEnd.loadId === refs.loadIdRef.current &&
                        refs.activeEngineTrackIdRef.current === trackId &&
                        refs.activeEngineLoadIdRef.current ===
                            refs.loadIdRef.current &&
                        audioEngine.hasTrackEnded()
                    ) {
                        // Online queue continuation may still be waiting for
                        // recommendations. Its completed source must not be
                        // reloaded while that decision is pending. Replaying or
                        // loading another occurrence retires this condition.
                        return;
                    }
                    const startupStability = startupStabilityRef.current;
                    const startupNoProgress =
                        playbackTypeRef.current === "track" &&
                        Boolean(trackId) &&
                        startupStability.trackId === trackId &&
                        startupStability.firstProgressAtMs === null;
                    const suppressionReason = seekReloadInProgressRef.current
                        ? "seek_reload_in_progress"
                        : isLoadingRef.current
                          ? "load_in_progress"
                          : startupNoProgress
                            ? "startup_no_progress"
                            : null;
                    if (suppressionReason) {
                        if (trackId && startupNoProgress) {
                            unexpectedStopStartupGuardRef.current = {
                                trackId,
                                suppressUntilMs:
                                    Date.now() +
                                    UNEXPECTED_STOP_STARTUP_GUARD_MS,
                                reason: "startup_no_progress",
                            };
                            scheduleStartupPlaybackRecovery(trackId);
                        }
                        logPlaybackClientMetric(
                            "player.unexpected_stop_suppressed",
                            {
                                reason: suppressionReason,
                                trackId,
                                sourceType: currentTrackRef.current
                                    ? resolveDirectTrackSourceType(
                                          currentTrackRef.current,
                                      )
                                    : "unknown",
                            },
                        );
                        return;
                    }

                    const startupGuard = unexpectedStopStartupGuardRef.current;
                    const startupGuardActive =
                        playbackTypeRef.current === "track" &&
                        Boolean(trackId) &&
                        startupGuard.trackId === trackId &&
                        Date.now() < startupGuard.suppressUntilMs;
                    if (startupGuardActive) {
                        logPlaybackClientMetric(
                            "player.unexpected_stop_suppressed",
                            {
                                reason: "startup_guard_active",
                                trackId,
                                sourceType: currentTrackRef.current
                                    ? resolveDirectTrackSourceType(
                                          currentTrackRef.current,
                                      )
                                    : "unknown",
                                guardReason: startupGuard.reason,
                                guardRemainingMs: Math.max(
                                    0,
                                    startupGuard.suppressUntilMs - Date.now(),
                                ),
                            },
                        );
                        return;
                    }

                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Heartbeat detected unexpected stop",
                    );
                    logPlaybackClientMetric("player.unexpected_stop", {
                        reason: "heartbeat_unexpected_stop",
                        trackId,
                        sourceType: currentTrackRef.current
                            ? resolveDirectTrackSourceType(
                                  currentTrackRef.current,
                              )
                            : "unknown",
                    });

                    if (!lastPlayingStateRef.current) {
                        if (playbackStateMachine.isPlaying) {
                            // User intent is paused; align machine state only.
                            playbackStateMachine.forceTransition("READY");
                        }
                        return;
                    }

                    if (playbackTypeRef.current !== "track") {
                        setIsPlaying(false);
                        setIsBuffering(false);
                        playbackStateMachine.forceTransition("READY");
                        return;
                    }

                    const stopError = new PlaybackInterruptionError(
                        "unexpected_stop",
                    );
                    const failedTrackId = currentTrackRef.current?.id ?? null;
                    setIsBuffering(true);
                    playbackStateMachine.forceTransition("LOADING");

                    const didScheduleTransientRecovery =
                        attemptTransientTrackRecovery(failedTrackId, stopError);
                    if (didScheduleTransientRecovery) {
                        return;
                    }

                    setIsPlaying(false);
                    setIsBuffering(false);
                    playbackStateMachine.forceTransition("READY");
                },
                onBufferTimeout: () => {
                    const bufferedAhead = audioEngine.getBufferedAheadSec?.();
                    const pipelineStalled =
                        isDevicePlaybackSourceUrl(getPlaybackSourceUrl()) ||
                        (typeof bufferedAhead === "number" &&
                            Number.isFinite(bufferedAhead) &&
                            bufferedAhead > 1);
                    sharedFrontendLogger.error(
                        "[AudioPlaybackOrchestrator] Audio progress timed out",
                    );
                    logPlaybackClientMetric("player.rebuffer_timeout", {
                        reason: "heartbeat_buffer_timeout",
                        trackId: currentTrackRef.current?.id ?? null,
                        sourceType: currentTrackRef.current
                            ? resolveDirectTrackSourceType(
                                  currentTrackRef.current,
                              )
                            : "unknown",
                    });
                    const timeoutError = pipelineStalled
                        ? new PlaybackInterruptionError("audio_pipeline_stall")
                        : new Error("Connection lost - audio stream timed out");
                    const failPlayback = () => {
                        if (audioEngine.isPlaying()) {
                            audioEngine.pause();
                        }
                        playbackStateMachine.transition("ERROR", {
                            error: timeoutError.message,
                            errorCode: 408,
                        });
                        setIsPlaying(false);
                        setIsBuffering(false);
                        heartbeatRef.current?.stop();
                    };

                    if (playbackTypeRef.current !== "track") {
                        failPlayback();
                        return;
                    }

                    const failedTrackId = currentTrackRef.current?.id ?? null;
                    if (
                        !pipelineStalled &&
                        currentTrackRef.current?.streamSource === "youtube" &&
                        lastPlayingStateRef.current &&
                        startupStabilityRef.current.trackId === failedTrackId &&
                        startupStabilityRef.current.firstProgressAtMs !==
                            null &&
                        refs.engineEventHandlersRef.current
                    ) {
                        // Use the same bounded replacement and queue-preserving
                        // failure path as a terminal media network error.
                        void refs.engineEventHandlersRef.current.handleError({
                            error: timeoutError,
                            code: "MEDIA_ERR_NETWORK",
                            recoverable: false,
                        });
                        return;
                    }
                    const didScheduleTransientRecovery =
                        attemptTransientTrackRecovery(
                            failedTrackId,
                            timeoutError,
                        );
                    if (didScheduleTransientRecovery) {
                        playbackStateMachine.forceTransition("LOADING");
                        setIsBuffering(true);
                        return;
                    }

                    failPlayback();
                },
                onRecovery: () => {
                    // Recovered from stall
                    sharedFrontendLogger.info(
                        "[AudioPlaybackOrchestrator] Recovered from stall",
                    );
                    logPlaybackClientMetric("player.rebuffer_recovered", {
                        reason: "heartbeat_recovery",
                        trackId: currentTrackRef.current?.id ?? null,
                        sourceType: currentTrackRef.current
                            ? resolveDirectTrackSourceType(
                                  currentTrackRef.current,
                              )
                            : "unknown",
                    });
                    const enginePlaying = audioEngine.isPlaying();
                    const recoveryAction = resolveBufferingRecoveryAction({
                        machineIsBuffering: playbackStateMachine.isBuffering,
                        machineIsPlaying: playbackStateMachine.isPlaying,
                        engineIsPlaying: enginePlaying,
                    });
                    if (recoveryAction === "transition_playing") {
                        playbackStateMachine.transition("PLAYING");
                    } else if (recoveryAction === "force_playing") {
                        playbackStateMachine.forceTransition("PLAYING");
                    }
                    setIsBuffering(false);
                    setIsPlaying(enginePlaying);
                },
                getCurrentTime: () => audioEngine.getCurrentTime(),
                isActuallyPlaying: () => audioEngine.isPlaying(),
            },
            {
                bufferTimeout: HEARTBEAT_BUFFER_TIMEOUT_MS,
            },
        );

        return () => {
            heartbeatRef.current?.destroy();
            heartbeatRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        attemptTransientTrackRecovery,
        scheduleStartupPlaybackRecovery,
        setIsBuffering,
        setIsPlaying,
        getPlaybackSourceUrl,
    ]);

    // Keep heartbeat active while buffering so stall timeouts can still fire.
    useEffect(() => {
        if (isPlaying || isBuffering) {
            heartbeatRef.current?.start();
        } else {
            heartbeatRef.current?.stop();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [isPlaying, isBuffering]);
}
