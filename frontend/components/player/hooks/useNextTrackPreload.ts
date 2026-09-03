import { useCallback, useEffect, useRef } from "react";
import type { Podcast, Track } from "@/lib/audio-state-context";
import type { QueueItem } from "@/lib/queue-item";
import { api } from "@/lib/api";
import {
    acquireDeviceOfflinePlaybackSource,
    hasDeviceOfflinePlaybackCopy,
    resolveDeviceOfflineMediaIdentity,
} from "@/features/device-offline/playbackResolver";
import { getNextTrackInfo } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import { resolveNetworkNextTrackPreloadDecision } from "@/lib/audio-engine/nextTrackPreloadPolicy";
import { resolveRemoteStreamFormat } from "../audioPlaybackOrchestratorPolicy";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { usePlaybackSourceLeaseController } from "./playbackSourceLeaseController";
import { observeIosBackgroundTrackHandoff } from "../iosBackgroundTrackHandoffController";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

interface UseNextTrackPreloadOptions {
    playbackType: "track" | "audiobook" | "podcast" | null;
    currentTrack: Track | null;
    currentPodcast: Podcast | null;
    isPlaying: boolean;
    queue: QueueItem[];
    currentIndex: number;
    isShuffle: boolean;
    shuffleIndices: number[];
    repeatMode: "off" | "one" | "all";
    refs: PlaybackOrchestratorRefs;
}

type PreloadableTrack = NonNullable<ReturnType<typeof getNextTrackInfo>>;
type PreloadTrackOptions = {
    /** Stable playback or natural end may prepare one network provider item. */
    allowNetworkYouTube?: boolean;
};
type NetworkPreloadTiming = {
    currentTimeSec: number;
    isLoading: boolean;
    loadedDurationSec: number;
    liveTrackId: string | null;
};
interface NextTrackPreloadController {
    preloadTrack: (
        track: PreloadableTrack,
        options?: PreloadTrackOptions,
    ) => void;
    preloadNetworkWhenDue: (timing: NetworkPreloadTiming) => void;
}

function isVerifiedDevicePlaybackUrl(url: string): boolean {
    return url.startsWith("blob:") || url.includes("/__offline/audio/");
}

/** Preloads the next music queue item without changing playback state. */
export function useNextTrackPreload({
    playbackType,
    currentTrack,
    currentPodcast,
    isPlaying,
    queue,
    currentIndex,
    isShuffle,
    shuffleIndices,
    repeatMode,
    refs,
}: UseNextTrackPreloadOptions): NextTrackPreloadController {
    const {
        iosBackgroundTrackHandoffRef,
        lastPreloadedTrackIdRef,
        ytMusicAuthenticatedRef,
    } = refs;
    const leaseController = usePlaybackSourceLeaseController();
    const preloadRequestIdRef = useRef(0);
    const preloadTrack = useCallback(
        (
            nextTrack: PreloadableTrack,
            options: PreloadTrackOptions = {},
        ): void => {
            const preloadIdentity =
                resolveDeviceOfflineMediaIdentity(nextTrack);
            if (preloadIdentity === lastPreloadedTrackIdRef.current) return;
            const requestId = ++preloadRequestIdRef.current;
            const isCurrentRequest = () =>
                preloadRequestIdRef.current === requestId &&
                lastPreloadedTrackIdRef.current === preloadIdentity;

            // A YouTube Music preload starts a real sidecar spool job. The
            // default effect remains device-only; the timing policy opts one
            // network item in after current playback is confirmed, and the end
            // handler may do the same as an iOS audio-session fallback.
            if (
                nextTrack.streamSource === "youtube" &&
                !hasDeviceOfflinePlaybackCopy(nextTrack) &&
                !options.allowNetworkYouTube
            ) {
                leaseController.release();
                lastPreloadedTrackIdRef.current = null;
                return;
            }

            let streamUrl: string;
            let format: string | undefined = "mp3";

            if (nextTrack.streamSource === "tidal" && nextTrack.tidalTrackId) {
                streamUrl = api.getTidalStreamUrl(nextTrack.tidalTrackId);
                format = resolveRemoteStreamFormat("tidal");
            } else if (
                nextTrack.streamSource === "youtube" &&
                nextTrack.youtubeVideoId
            ) {
                streamUrl = api.getYtMusicStreamUrl(
                    nextTrack.youtubeVideoId,
                    undefined,
                    !ytMusicAuthenticatedRef.current,
                );
                format = resolveRemoteStreamFormat("youtube");
            } else if (
                nextTrack.streamSource === "youtube-direct" &&
                nextTrack.youtubeVideoId
            ) {
                streamUrl = api.getYouTubeStreamUrl(nextTrack.youtubeVideoId);
                format =
                    nextTrack.youtubeAudioFormat === "webm" ? "webm" : "mp4";
            } else {
                streamUrl = api.getStreamUrl(nextTrack.id);
                const filePath = nextTrack.filePath || "";
                if (filePath) {
                    const ext = filePath.split(".").pop()?.toLowerCase();
                    if (ext === "flac") format = "flac";
                    else if (ext === "m4a" || ext === "aac") format = "mp4";
                    else if (ext === "ogg" || ext === "opus") format = "webm";
                    else if (ext === "wav") format = "wav";
                }
            }

            lastPreloadedTrackIdRef.current = preloadIdentity;
            void leaseController
                .acquire(
                    (signal) =>
                        acquireDeviceOfflinePlaybackSource(
                            nextTrack,
                            streamUrl,
                            signal,
                        ),
                    isCurrentRequest,
                )
                .then(
                    (resolvedUrl) => {
                        if (!isCurrentRequest()) return;
                        if (!resolvedUrl) {
                            lastPreloadedTrackIdRef.current = null;
                            return;
                        }
                        if (
                            nextTrack.streamSource === "youtube" &&
                            !options.allowNetworkYouTube &&
                            !isVerifiedDevicePlaybackUrl(resolvedUrl)
                        ) {
                            leaseController.release();
                            lastPreloadedTrackIdRef.current = null;
                            return;
                        }
                        audioEngine.preload(resolvedUrl, format);
                    },
                    () => {
                        if (isCurrentRequest()) {
                            lastPreloadedTrackIdRef.current = null;
                        }
                    },
                );
        },
        [lastPreloadedTrackIdRef, leaseController, ytMusicAuthenticatedRef],
    );

    const preloadNetworkWhenDue = useCallback(
        (timing: NetworkPreloadTiming): void => {
            const nextTrack = getNextTrackInfo(
                queue,
                currentIndex,
                isShuffle,
                shuffleIndices,
                repeatMode,
            );
            if (
                nextTrack &&
                resolveNetworkNextTrackPreloadDecision({
                    nextStreamSource: nextTrack.streamSource,
                    currentTimeSec: timing.currentTimeSec,
                    isPlaying: audioEngine.isPlaying(),
                    isLoading: timing.isLoading,
                }).shouldPreload
            ) {
                preloadTrack(nextTrack, { allowNetworkYouTube: true });
            }
            observeIosBackgroundTrackHandoff({
                refs,
                queue,
                currentIndex,
                isShuffle,
                shuffleIndices,
                repeatMode,
                liveTrackId: timing.liveTrackId,
                currentTimeSec: timing.currentTimeSec,
                loadedDurationSec: timing.loadedDurationSec,
            });
        },
        [
            queue,
            currentIndex,
            isShuffle,
            shuffleIndices,
            repeatMode,
            preloadTrack,
            refs,
        ],
    );

    // Preload next track for gapless playback (music only)
    useEffect(() => {
        iosBackgroundTrackHandoffRef.current.reset();
        // Preload while a track or podcast episode plays — but only when the
        // NEXT queue item is a music track (getNextTrackInfo returns null for
        // episode items). Audiobooks have no queue and never preload.
        const hasActiveQueueMedia =
            playbackType === "track"
                ? Boolean(currentTrack)
                : playbackType === "podcast"
                  ? Boolean(currentPodcast)
                  : false;
        if (!hasActiveQueueMedia || !isPlaying) {
            preloadRequestIdRef.current += 1;
            leaseController.release();
            lastPreloadedTrackIdRef.current = null;
            return;
        }

        const nextTrack = getNextTrackInfo(
            queue,
            currentIndex,
            isShuffle,
            shuffleIndices,
            repeatMode,
        );

        if (!nextTrack) {
            preloadRequestIdRef.current += 1;
            leaseController.release();
            lastPreloadedTrackIdRef.current = null;
            return;
        }
        preloadTrack(nextTrack);
    }, [
        playbackType,
        currentTrack,
        currentPodcast,
        isPlaying,
        queue,
        currentIndex,
        isShuffle,
        shuffleIndices,
        repeatMode,
        iosBackgroundTrackHandoffRef,
        leaseController,
        lastPreloadedTrackIdRef,
        preloadTrack,
    ]);

    return { preloadTrack, preloadNetworkWhenDue };
}
