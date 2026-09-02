import { toast } from "sonner";
import { playbackStateMachine } from "@/lib/audio";
import type { Track } from "@/lib/audio-state-context";
import type { AudioEngineErrorPayload } from "@/lib/audio-engine/types";
import {
    logPlaybackClientMetric,
    orchestratorLogger,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import {
    resolveDirectTrackSourceType,
    isProviderStartupFailure,
    shouldAttemptOuterTransientRecovery,
} from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import {
    getDeviceOfflinePlaybackErrorMessage,
    hasDeviceOfflinePlaybackCopy,
} from "@/features/device-offline/playbackResolver";
import { getListenTogetherSessionSnapshot } from "@/lib/listen-together-session";
import { frontendLogger } from "@/lib/logger";
import type { UnavailableYtMusicRecoveryOutcome } from "@/lib/audio/unavailableYtMusicRecovery";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import { isPlaybackFailureSupersededByManualIntent } from "@/lib/audio-engine/playbackAdvanceOrigin";
import {
    getTrackProviderFailureKey,
    providerFailureCooldown,
} from "@/lib/audio-engine/providerFailureCooldown";
import { classifyPlaybackError } from "@/lib/audio-engine/playbackErrorCategory";

type PlaybackType = "track" | "audiobook" | "podcast" | null;

interface PlaybackErrorHandlerOptions {
    refs: PlaybackOrchestratorRefs;
    playbackType: PlaybackType;
    currentTrack: Track | null;
    queueLength: number;
    setIsPlaying(value: boolean): void;
    setIsBuffering(value: boolean): void;
    setCurrentTrack(value: null): void;
    setCurrentAudiobook(value: null): void;
    setCurrentPodcast(value: null): void;
    setPlaybackType(value: null): void;
    clearPendingTrackErrorSkip(): void;
    clearStartupPlaybackRecovery(): void;
    clearTransientTrackRecovery(resetAttempts: boolean): void;
    releasePlaybackSource(): void;
    attemptUnavailableYtMusicRecovery(
        track: Track | null,
    ): Promise<UnavailableYtMusicRecoveryOutcome>;
    attemptTransientTrackRecovery(
        failedTrackId: string | null,
        error: unknown,
    ): boolean;
    scheduleTrackErrorSkip(
        failedTrackId: string | null,
        disposition?:
            | { kind: "system_failure" }
            | {
                  kind: "confirmed_provider_unavailable";
                  failureKey: string;
              },
    ): boolean;
    finishFailedPlay(): void;
}

/** Build the current-render error delegate consumed by stable engine bindings. */
export function createPlaybackErrorHandler({
    refs,
    playbackType,
    currentTrack,
    queueLength,
    setIsPlaying,
    setIsBuffering,
    setCurrentTrack,
    setCurrentAudiobook,
    setCurrentPodcast,
    setPlaybackType,
    clearPendingTrackErrorSkip,
    clearStartupPlaybackRecovery,
    clearTransientTrackRecovery,
    releasePlaybackSource,
    attemptUnavailableYtMusicRecovery,
    attemptTransientTrackRecovery,
    scheduleTrackErrorSkip,
    finishFailedPlay,
}: PlaybackErrorHandlerOptions) {
    const {
        currentTrackRef,
        howlerLoadStartMsRef,
        recoverablePlayErrorPendingRef,
        isUserInitiatedRef,
        heartbeatRef,
        lastTrackIdRef,
        isLoadingRef,
    } = refs;

    return async (data: AudioEngineErrorPayload): Promise<void> => {
        if (
            playbackType === "track" &&
            currentTrack &&
            isPlaybackFailureSupersededByManualIntent(currentTrack.id)
        ) {
            logPlaybackClientMetric("player.playback_cancelled", {
                trackId: currentTrack.id,
                sourceType: resolveDirectTrackSourceType(currentTrack),
                reason: "superseded_manual_intent",
            });
            orchestratorLogger.info(
                "Ignored playback error from a superseded manual occurrence",
                { trackId: currentTrack.id },
            );
            return;
        }

        if (data.code === "NotAllowedError" || data.recoverable === true) {
            orchestratorLogger.warn(
                "Playback deferred for browser-owned recovery",
                {
                    code: data.code ?? null,
                    recoverable: data.recoverable === true,
                    trackId: currentTrackRef.current?.id ?? null,
                },
            );
            howlerLoadStartMsRef.current = 0;
            recoverablePlayErrorPendingRef.current = true;
            isUserInitiatedRef.current = false;
            playbackStateMachine.forceTransition("LOADING");
            setIsPlaying(false);
            setIsBuffering(true);
            return;
        }

        frontendLogger.error(
            "[AudioPlaybackOrchestrator] Playback error:",
            data.error,
        );
        howlerLoadStartMsRef.current = 0;
        const errorMessage =
            data.error instanceof Error
                ? data.error.message
                : String(data.error);
        const sourceType = currentTrack
            ? resolveDirectTrackSourceType(currentTrack)
            : "unknown";
        const errorCategory = classifyPlaybackError(data.error);
        const providerStartupFailure = isProviderStartupFailure({
            track: currentTrack,
            code: data.code,
            error: data.error,
            priorConsecutiveErrors:
                refs.consecutiveErrorBreakerRef.current.getErrorCount(),
        });

        if (
            playbackType === "track" &&
            typeof navigator !== "undefined" &&
            navigator.onLine === false
        ) {
            releasePlaybackSource();
            finishFailedPlay();
            const hasDeviceCopy = currentTrack
                ? hasDeviceOfflinePlaybackCopy(currentTrack)
                : false;
            playbackStateMachine.forceTransition("ERROR", {
                error: errorMessage,
            });
            setIsPlaying(false);
            setIsBuffering(false);
            recoverablePlayErrorPendingRef.current = false;
            isUserInitiatedRef.current = false;
            heartbeatRef.current?.stop();
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);
            toast.error(getDeviceOfflinePlaybackErrorMessage(hasDeviceCopy), {
                id: "device-offline-playback-error",
                duration: 5000,
            });
            return;
        }

        let confirmedProviderUnavailableFailureKey: string | null = null;
        if (playbackType === "track") {
            logPlaybackClientMetric("player.playback_error", {
                trackId: currentTrack?.id ?? null,
                sourceType,
                error: errorMessage,
                errorCategory,
                stage: "pre_recovery",
            });
            if (providerStartupFailure) {
                releasePlaybackSource();
                finishFailedPlay();
                playbackStateMachine.forceTransition("ERROR", {
                    error: errorMessage,
                });
                setIsPlaying(false);
                setIsBuffering(false);
                recoverablePlayErrorPendingRef.current = false;
                isUserInitiatedRef.current = false;
                heartbeatRef.current?.stop();
                clearPendingTrackErrorSkip();
                clearStartupPlaybackRecovery();
                clearTransientTrackRecovery(true);
                toast.error(
                    "Несколько треков YouTube Music подряд не загрузились. Текущий трек сохранён — повторите запуск немного позже.",
                    {
                        id: "youtube-provider-temporarily-unavailable",
                        duration: 6000,
                    },
                );
                logPlaybackClientMetric("player.playback_error", {
                    trackId: currentTrack?.id ?? null,
                    sourceType,
                    error: errorMessage,
                    errorCategory,
                    stage: "provider_startup_paused",
                });
                return;
            }
            const failedTrackId = currentTrack?.id ?? null;
            const transientScheduled =
                shouldAttemptOuterTransientRecovery({
                    error: data.error,
                    recoverable: data.recoverable,
                }) && attemptTransientTrackRecovery(failedTrackId, data.error);
            if (transientScheduled) {
                logPlaybackClientMetric("player.rebuffer", {
                    reason: "transient_track_recovery",
                    trackId: failedTrackId,
                    sourceType,
                });
                playbackStateMachine.forceTransition("LOADING");
                setIsBuffering(true);
                return;
            }
            const unavailableOutcome =
                await attemptUnavailableYtMusicRecovery(currentTrack);
            if (
                unavailableOutcome === "replaced" ||
                unavailableOutcome === "stale"
            ) {
                return;
            }
            // `no_candidate` is the only terminal provider outcome backed by
            // the server contract: the original returned 404/451 and no exact
            // playable alternate survived validation. Request failures and an
            // `original_available` probe remain system failures.
            if (unavailableOutcome === "no_candidate" && currentTrack) {
                confirmedProviderUnavailableFailureKey =
                    getTrackProviderFailureKey(currentTrack);
                if (confirmedProviderUnavailableFailureKey) {
                    providerFailureCooldown.markUnavailable(
                        confirmedProviderUnavailableFailureKey,
                    );
                }
            }
        }

        if (playbackType === "track") {
            releasePlaybackSource();
            finishFailedPlay();
        }
        playbackStateMachine.forceTransition("ERROR", { error: errorMessage });
        if (
            playbackType === "track" &&
            (currentTrack?.streamSource === "youtube" ||
                currentTrack?.streamSource === "youtube-direct")
        ) {
            const source =
                currentTrack.streamSource === "youtube-direct"
                    ? "YouTube"
                    : "YouTube Music";
            toast.error(
                `Не удалось воспроизвести «${currentTrack.title}» через ${source}. ${queueLength > 1 ? "Пробуем следующий трек." : "Повторите попытку или выберите другую версию."}`,
                { duration: 5000 },
            );
        }

        setIsPlaying(false);
        setIsBuffering(false);
        logPlaybackClientMetric("player.playback_error", {
            trackId: currentTrack?.id ?? null,
            sourceType,
            error: errorMessage,
            errorCategory,
            stage: playbackType === "track" ? "fatal_after_recovery" : "fatal",
        });
        recoverablePlayErrorPendingRef.current = false;
        isUserInitiatedRef.current = false;
        heartbeatRef.current?.stop();
        clearTransientTrackRecovery(true);

        if (playbackType === "track") {
            const failedTrackId = currentTrack?.id ?? null;
            if (getListenTogetherSessionSnapshot()?.groupId) {
                if (
                    scheduleTrackErrorSkip(
                        failedTrackId,
                        confirmedProviderUnavailableFailureKey
                            ? {
                                  kind: "confirmed_provider_unavailable",
                                  failureKey:
                                      confirmedProviderUnavailableFailureKey,
                              }
                            : undefined,
                    )
                )
                    return;
                playbackStateMachine.forceTransition("LOADING");
                setIsBuffering(true);
                return;
            }
            if (queueLength > 1) {
                scheduleTrackErrorSkip(
                    failedTrackId,
                    confirmedProviderUnavailableFailureKey
                        ? {
                              kind: "confirmed_provider_unavailable",
                              failureKey:
                                  confirmedProviderUnavailableFailureKey,
                          }
                        : undefined,
                );
                return;
            }
            clearPendingTrackErrorSkip();
            const isNetworkError =
                errorMessage.includes("network") ||
                errorMessage.includes("MEDIA_ERR_NETWORK") ||
                data.code === "2";
            if (!isNetworkError) {
                lastTrackIdRef.current = null;
                isLoadingRef.current = false;
                setCurrentTrack(null);
                setPlaybackType(null);
            }
        } else if (playbackType === "audiobook") {
            clearPendingTrackErrorSkip();
            setCurrentAudiobook(null);
            setPlaybackType(null);
        } else if (playbackType === "podcast") {
            clearPendingTrackErrorSkip();
            setCurrentPodcast(null);
            setPlaybackType(null);
        }
    };
}
