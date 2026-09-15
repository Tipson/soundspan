import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { api } from "@/lib/api";
import { playbackStateMachine } from "@/lib/audio";
import { audioSeekEmitter } from "@/lib/audio-seek-emitter";
import {
    getAuthRuntimeGeneration,
    getAuthRuntimeLease,
} from "@/lib/auth-runtime-generation";
import { isListenTogetherActiveOrPending } from "@/lib/listen-together-session";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { isLikelyTransientStreamError } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import {
    isPlaybackAutoRestartSuppressed,
    isPlaybackFailureSupersededByManualIntent,
} from "@/lib/audio-engine/playbackAdvanceOrigin";
import {
    createServerMusicSourceRecovery,
    type ServerSourceRecoveryOutcome,
} from "@/lib/audio/serverMusicSourceRecovery";
import { loadRecoveredMusicSource } from "@/lib/audio/loadRecoveredMusicSource";
import type { AudioEngineErrorPayload } from "@/lib/audio-engine/types";
import type { Track } from "@/lib/audio-state-context";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { usePlaybackRecoveryHelpers } from "./usePlaybackRecoveryHelpers";
import { isDevicePlaybackSourceUrl } from "./playbackSourceLeaseController";

interface Options {
    refs: PlaybackOrchestratorRefs;
    currentTrack: Track | null;
    playbackType: "track" | "audiobook" | "podcast" | null;
    isPlaying: boolean;
    playbackRecoveryHelpers: ReturnType<typeof usePlaybackRecoveryHelpers>;
    setCurrentTime(time: number): void;
    setIsBuffering(value: boolean): void;
    applyCurrentOutputState(): void;
    releasePlaybackSource(): void;
    getPlaybackSourceUrl(): string | null;
}

/** Own automatic mid-track transport replacement without modifying the queue or recording. */
export function useServerMusicSourceRecovery(options: Options) {
    const latest = useRef(options);
    useLayoutEffect(() => {
        latest.current = options;
    });
    const coordinator = useRef<ReturnType<
        typeof createServerMusicSourceRecovery
    > | null>(null);
    const recoveryPosition = useRef<{ key: string; value: number } | null>(
        null,
    );
    const { currentTrack, playbackType, isPlaying } = options;

    useEffect(() => {
        if (isPlaying) coordinator.current?.reset();
        return () => coordinator.current?.cancel();
    }, [
        currentTrack?.id,
        currentTrack?.playlistItemId,
        currentTrack?.youtubeVideoId,
        playbackType,
        isPlaying,
    ]);
    useEffect(
        () =>
            audioSeekEmitter.subscribe((time) => {
                if (recoveryPosition.current && Number.isFinite(time))
                    recoveryPosition.current.value = time;
            }),
        [],
    );

    return useCallback(
        async (
            error: AudioEngineErrorPayload,
        ): Promise<ServerSourceRecoveryOutcome> => {
            const initial = latest.current;
            const { refs } = initial;
            const track = refs.currentTrackRef.current;
            const stability = refs.startupStabilityRef.current;
            const sourceUrl = initial.getPlaybackSourceUrl();
            if (
                isDevicePlaybackSourceUrl(sourceUrl) ||
                !track ||
                !track.artist?.name ||
                !track.title ||
                !Number.isFinite(track.duration) ||
                track.streamSource !== "youtube" ||
                !track.youtubeVideoId ||
                refs.playbackTypeRef.current !== "track" ||
                !refs.lastPlayingStateRef.current ||
                stability.trackId !== track.id ||
                stability.firstProgressAtMs === null ||
                isListenTogetherActiveOrPending() ||
                isPlaybackAutoRestartSuppressed() ||
                isPlaybackFailureSupersededByManualIntent(track.id) ||
                (typeof navigator !== "undefined" &&
                    navigator.onLine === false) ||
                !(
                    error.code === "2" ||
                    error.code === "MEDIA_ERR_NETWORK" ||
                    isLikelyTransientStreamError(error.error)
                )
            ) {
                return "not_applicable";
            }
            const positionSec =
                initial.playbackRecoveryHelpers.readTrustedTrackPositionSec(
                    track.id,
                );
            if (
                !Number.isFinite(positionSec) ||
                positionSec <= 0 ||
                positionSec >= track.duration - 1
            )
                return "not_applicable";
            const currentKey = () => {
                const state = latest.current.refs;
                const current = state.currentTrackRef.current;
                return JSON.stringify([
                    current?.id,
                    current?.playlistItemId,
                    current?.youtubeVideoId,
                    state.loadIdRef.current,
                    getAuthRuntimeGeneration(),
                ]);
            };
            const isCurrent = (input: { key: string }) =>
                currentKey() === input.key &&
                latest.current.refs.playbackTypeRef.current === "track" &&
                latest.current.refs.lastPlayingStateRef.current &&
                !isListenTogetherActiveOrPending() &&
                !isPlaybackAutoRestartSuppressed() &&
                !isPlaybackFailureSupersededByManualIntent(
                    latest.current.refs.currentTrackRef.current?.id ?? null,
                );
            if (!coordinator.current)
                coordinator.current = createServerMusicSourceRecovery({
                    isCurrent,
                    resolve: async (recording, signal) => {
                        const state = latest.current;
                        state.playbackRecoveryHelpers.clearStartupPlaybackRecovery();
                        state.playbackRecoveryHelpers.clearPendingTrackErrorSkip();
                        state.playbackRecoveryHelpers.clearTransientTrackRecovery(
                            false,
                        );
                        state.refs.trackEndWatchdogRef.current?.clear();
                        state.refs.heartbeatRef.current?.stop();
                        state.refs.serverSourceRecoveryLoadIdRef.current =
                            state.refs.loadIdRef.current;
                        state.refs.isLoadingRef.current = true;
                        state.setIsBuffering(true);
                        playbackStateMachine.forceTransition("LOADING");
                        await audioEngine.stop();
                        signal.throwIfAborted();
                        state.releasePlaybackSource();
                        return api.resolveMusicSourceForRecovery(
                            recording,
                            signal,
                        );
                    },
                    apply: async (url, input, signal) => {
                        const state = latest.current;
                        await loadRecoveredMusicSource({
                            engine: audioEngine,
                            url,
                            trackId: state.refs.currentTrackRef.current!.id,
                            durationSec: input.recording.duration,
                            positionSec: input.positionSec,
                            signal,
                            isCurrent: () => isCurrent(input),
                            getPositionSec: () =>
                                recoveryPosition.current?.key === input.key
                                    ? recoveryPosition.current.value
                                    : input.positionSec,
                            onReady: (restoredPosition) => {
                                const active = latest.current;
                                active.refs.serverSourceRecoveryLoadIdRef.current =
                                    null;
                                active.refs.isLoadingRef.current = false;
                                active.refs.activeEngineTrackIdRef.current =
                                    active.refs.currentTrackRef.current!.id;
                                active.refs.activeEngineLoadIdRef.current =
                                    active.refs.loadIdRef.current;
                                active.refs.providerFailedLoadIdRef.current =
                                    null;
                                active.setCurrentTime(restoredPosition);
                                active.setIsBuffering(false);
                                active.applyCurrentOutputState();
                            },
                        });
                    },
                });
            const input = {
                key: currentKey(),
                positionSec,
                recording: {
                    title: track.title,
                    artists: [track.artist.name],
                    duration: track.duration,
                    contentVersion: "unknown" as const,
                },
            };
            if (recoveryPosition.current?.key !== input.key)
                recoveryPosition.current = {
                    key: input.key,
                    value: positionSec,
                };
            const auth = getAuthRuntimeLease();
            const capturedLoadId = refs.loadIdRef.current;
            const cancel = () => coordinator.current?.cancel();
            auth.signal.addEventListener("abort", cancel, { once: true });
            try {
                let result = await coordinator.current.recover(input);
                if (
                    (result === "failed" ||
                        result === "no_candidate" ||
                        result === "exhausted") &&
                    currentKey() === input.key
                ) {
                    // Native pause() ignores a terminal error state. Stop also
                    // clears pending autoplay/retry work and buffered playback.
                    await audioEngine.stop();
                    if (currentKey() !== input.key) result = "stale";
                }
                if (
                    result !== "in_progress" &&
                    recoveryPosition.current?.key === input.key
                ) {
                    recoveryPosition.current = null;
                    if (
                        refs.serverSourceRecoveryLoadIdRef.current ===
                        capturedLoadId
                    ) {
                        refs.serverSourceRecoveryLoadIdRef.current = null;
                        if (refs.loadIdRef.current === capturedLoadId)
                            refs.isLoadingRef.current = false;
                    }
                }
                if (
                    result !== "in_progress" &&
                    result !== "exhausted" &&
                    currentKey() === input.key
                ) {
                    refs.isLoadingRef.current = false;
                    if (result !== "recovered") {
                        initial.setIsBuffering(false);
                        refs.providerFailedLoadIdRef.current =
                            refs.loadIdRef.current;
                        if (!refs.lastPlayingStateRef.current)
                            playbackStateMachine.forceTransition("READY");
                    }
                    logPlaybackClientMetric(
                        result === "recovered"
                            ? "player.rebuffer_recovered"
                            : "player.rebuffer_timeout",
                        {
                            reason: "server_source_recovery",
                            outcome: result,
                            trackId: track.id,
                        },
                    );
                }
                return result;
            } finally {
                auth.signal.removeEventListener("abort", cancel);
            }
        },
        [],
    );
}
