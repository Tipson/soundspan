import { useEffect, useLayoutEffect } from "react";
import { api } from "@/lib/api";
import { playbackStateMachine } from "@/lib/audio";
import type { Podcast, Track } from "@/lib/audio-state-context";
import { AUTOPLAY_INTENT_CONFLICT_WINDOW_MS } from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import { useLoudnessNormalization } from "./useLoudnessNormalization";
import {
    consumePlaybackAdvanceOrigin,
    isPlaybackAutoRestartSuppressed,
} from "@/lib/audio-engine/playbackAdvanceOrigin";
import { getListenTogetherSessionSnapshot } from "@/lib/listen-together-session";

interface UsePlaybackControlSyncOptions {
    refs: PlaybackOrchestratorRefs;
    playbackType: "track" | "audiobook" | "podcast" | null;
    currentPodcast: Podcast | null;
    currentTrack: Track | null;
    isPlaying: boolean;
    repeatMode: "off" | "one" | "all";
    volume: number;
    isMuted: boolean;
    setCanSeek: (canSeek: boolean) => void;
    setDownloadProgress: (progress: number | null) => void;
    applyCurrentOutputState: () => void;
    scheduleStartupPlaybackRecovery: (
        trackId: string | null,
        recheckCount?: number,
    ) => void;
    clearStartupPlaybackRecovery: () => void;
}

/** Synchronizes cache, intent, and output controls with the audio engine. */
export function usePlaybackControlSync({
    refs,
    playbackType,
    currentPodcast,
    currentTrack,
    isPlaying,
    repeatMode,
    volume,
    isMuted,
    setCanSeek,
    setDownloadProgress,
    applyCurrentOutputState,
    scheduleStartupPlaybackRecovery,
    clearStartupPlaybackRecovery,
}: UsePlaybackControlSyncOptions): void {
    const {
        cacheStatusPollingRef,
        lastPlayingStateRef,
        desiredLoadPlayRef,
        isLoadingRef,
        loadIdRef,
        cancelledLoadPlayIdRef,
        isUserInitiatedRef,
        consecutiveErrorBreakerRef,
        trackEndWatchdogRef,
        outputStateRef,
    } = refs;

    // Volume leveling (#526): keeps the gain factor applied by
    // applyCurrentOutputState in sync with the current track and user mode.
    useLoudnessNormalization({
        loudnessGainFactorRef: refs.loudnessGainFactorRef,
        applyCurrentOutputState,
    });

    // Check podcast cache status and control canSeek
    useEffect(() => {
        if (playbackType !== "podcast") {
            setCanSeek(true);
            setDownloadProgress(null);
            if (cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
            return;
        }

        if (!currentPodcast) {
            setCanSeek(true);
            return;
        }

        const [podcastId, episodeId] = currentPodcast.id.split(":");

        const checkCacheStatus = async () => {
            try {
                const status = await api.getPodcastEpisodeCacheStatus(
                    podcastId,
                    episodeId,
                );

                if (status.cached) {
                    setCanSeek(true);
                    setDownloadProgress(null);
                    if (cacheStatusPollingRef.current) {
                        clearInterval(cacheStatusPollingRef.current);
                        cacheStatusPollingRef.current = null;
                    }
                } else {
                    setCanSeek(false);
                    setDownloadProgress(
                        status.downloadProgress ??
                            (status.downloading ? 0 : null),
                    );
                }

                return status.cached;
            } catch (err) {
                sharedFrontendLogger.error(
                    "[AudioPlaybackOrchestrator] Failed to check cache status:",
                    err,
                );
                setCanSeek(true);
                return true;
            }
        };

        checkCacheStatus();

        cacheStatusPollingRef.current = setInterval(async () => {
            const isCached = await checkCacheStatus();
            if (isCached && cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
        }, 5000);

        return () => {
            if (cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [currentPodcast, playbackType, setCanSeek, setDownloadProgress]);

    // Keep lastPlayingStateRef always in sync
    useLayoutEffect(() => {
        lastPlayingStateRef.current = isPlaying;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [isPlaying]);

    // Handle play/pause changes from UI
    // Skip if a track change is in progress -- the track-change effect handles playback.
    // This prevents doubled audio when next() sets both currentTrack and isPlaying simultaneously.
    useEffect(() => {
        if (!isPlaying) {
            const desiredLoadPlay = desiredLoadPlayRef.current;
            const shouldReportAutoplayConflict = Boolean(
                !isLoadingRef.current &&
                audioEngine.isPlaying() &&
                desiredLoadPlay?.shouldPlay &&
                desiredLoadPlay.loadId === loadIdRef.current &&
                Date.now() - desiredLoadPlay.decidedAtMs <=
                    AUTOPLAY_INTENT_CONFLICT_WINDOW_MS,
            );
            if (shouldReportAutoplayConflict && desiredLoadPlay) {
                logPlaybackClientMetric("player.autoplay_intent_conflict", {
                    loadId: desiredLoadPlay.loadId,
                });
            }
            desiredLoadPlayRef.current = null;
            cancelledLoadPlayIdRef.current = loadIdRef.current;
        }

        if (isLoadingRef.current) {
            if (isPlaying) {
                const advanceOrigin = consumePlaybackAdvanceOrigin();
                if (advanceOrigin?.origin === "manual") {
                    consecutiveErrorBreakerRef.current.reset();
                }
                const listenTogetherSnapshot =
                    getListenTogetherSessionSnapshot();
                const isListenTogetherFollower = Boolean(
                    listenTogetherSnapshot?.groupId &&
                    !listenTogetherSnapshot.isHost,
                );
                if (
                    !isListenTogetherFollower &&
                    !isPlaybackAutoRestartSuppressed()
                ) {
                    desiredLoadPlayRef.current = {
                        loadId: loadIdRef.current,
                        shouldPlay: true,
                        decidedAtMs: Date.now(),
                    };
                    cancelledLoadPlayIdRef.current = null;
                }
            }
            return;
        }

        // An already-playing native engine ignores play() without emitting
        // another play event. Do not leave a user-action marker waiting for
        // that nonexistent event: it would consume the next external pause.
        isUserInitiatedRef.current = !isPlaying || !audioEngine.isPlaying();

        if (isPlaying) {
            const advanceOrigin = consumePlaybackAdvanceOrigin();
            if (advanceOrigin?.origin === "manual") {
                consecutiveErrorBreakerRef.current.reset();
            }
            if (isPlaybackAutoRestartSuppressed()) return;
            applyCurrentOutputState();
            if (
                playbackType === "track" &&
                currentTrack?.streamSource === "youtube" &&
                (playbackStateMachine.getState() === "ERROR" ||
                    refs.providerFailedLoadIdRef.current === loadIdRef.current)
            ) {
                // play() cannot revive a media element with a terminal source
                // error. Reload on explicit retry, without advancing the queue.
                const expectedLoadId = loadIdRef.current;
                refs.providerFailedLoadIdRef.current = null;
                const expectedTrack = currentTrack;
                const onRetryLoaded = () => {
                    audioEngine.off("load", onRetryLoaded);
                    const activeTrack = refs.currentTrackRef.current;
                    const session = getListenTogetherSessionSnapshot();
                    if (
                        !lastPlayingStateRef.current ||
                        loadIdRef.current !== expectedLoadId ||
                        activeTrack?.id !== expectedTrack.id ||
                        activeTrack?.playlistItemId !==
                            expectedTrack.playlistItemId ||
                        (session?.groupId && !session.isHost) ||
                        isPlaybackAutoRestartSuppressed()
                    )
                        return;
                    refs.activeEngineTrackIdRef.current = expectedTrack.id;
                    refs.activeEngineLoadIdRef.current = expectedLoadId;
                    if (!audioEngine.isPlaying()) audioEngine.play();
                };
                playbackStateMachine.forceTransition("LOADING");
                audioEngine.on("load", onRetryLoaded);
                scheduleStartupPlaybackRecovery(currentTrack.id);
                audioEngine.reload();
                return () => audioEngine.off("load", onRetryLoaded);
            }
            audioEngine.play();
            if (playbackType === "track" && currentTrack?.id) {
                scheduleStartupPlaybackRecovery(currentTrack.id);
            }
        } else {
            trackEndWatchdogRef.current?.clear();
            clearStartupPlaybackRecovery();
            audioEngine.pause();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        isPlaying,
        playbackType,
        currentTrack?.id,
        repeatMode,
        applyCurrentOutputState,
        scheduleStartupPlaybackRecovery,
        clearStartupPlaybackRecovery,
    ]);

    // Keep audio engine output state aligned with UI controls.
    useEffect(() => {
        outputStateRef.current = { volume, isMuted };
        applyCurrentOutputState();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [volume, isMuted, applyCurrentOutputState]);
}
