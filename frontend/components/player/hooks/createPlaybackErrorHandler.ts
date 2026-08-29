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
    scheduleTrackErrorSkip(failedTrackId: string | null): boolean;
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

        if (playbackType === "track") {
            logPlaybackClientMetric("player.playback_error", {
                trackId: currentTrack?.id ?? null,
                sourceType,
                error: errorMessage,
                stage: "pre_recovery",
            });
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
                `Couldn't stream "${currentTrack.title}" from ${source}. ${queueLength > 1 ? "Trying the next track." : "Try again or choose another version."}`,
                { duration: 5000 },
            );
        }

        setIsPlaying(false);
        setIsBuffering(false);
        logPlaybackClientMetric("player.playback_error", {
            trackId: currentTrack?.id ?? null,
            sourceType,
            error: errorMessage,
            stage: playbackType === "track" ? "fatal_after_recovery" : "fatal",
        });
        recoverablePlayErrorPendingRef.current = false;
        isUserInitiatedRef.current = false;
        heartbeatRef.current?.stop();
        clearTransientTrackRecovery(true);

        if (playbackType === "track") {
            const failedTrackId = currentTrack?.id ?? null;
            if (getListenTogetherSessionSnapshot()?.groupId) {
                if (scheduleTrackErrorSkip(failedTrackId)) return;
                playbackStateMachine.forceTransition("LOADING");
                setIsBuffering(true);
                return;
            }
            if (queueLength > 1) {
                scheduleTrackErrorSkip(failedTrackId);
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
