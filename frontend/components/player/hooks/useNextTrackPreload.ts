import { useCallback, useEffect, type MutableRefObject } from "react";
import type { Podcast, Track } from "@/lib/audio-state-context";
import type { QueueItem } from "@/lib/queue-item";
import { api } from "@/lib/api";
import {
    acquireDeviceOfflinePlaybackSource,
    resolveDeviceOfflineMediaIdentity,
} from "@/features/device-offline/playbackResolver";
import { getNextTrackInfo } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import { resolveRemoteStreamFormat } from "../audioPlaybackOrchestratorPolicy";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { usePlaybackSourceLeaseController } from "./playbackSourceLeaseController";

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
    lastPreloadedTrackIdRef: MutableRefObject<string | null>;
    ytMusicAuthenticatedRef: MutableRefObject<boolean>;
}

type PreloadableTrack = NonNullable<ReturnType<typeof getNextTrackInfo>>;

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
    lastPreloadedTrackIdRef,
    ytMusicAuthenticatedRef,
}: UseNextTrackPreloadOptions): (track: PreloadableTrack) => void {
    const leaseController = usePlaybackSourceLeaseController();
    const preloadTrack = useCallback(
        (nextTrack: PreloadableTrack): void => {
            const preloadIdentity =
                resolveDeviceOfflineMediaIdentity(nextTrack);
            if (preloadIdentity === lastPreloadedTrackIdRef.current) return;

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
                    () => lastPreloadedTrackIdRef.current === preloadIdentity,
                )
                .then(
                    (resolvedUrl) => {
                        if (resolvedUrl) {
                            audioEngine.preload(resolvedUrl, format);
                        }
                    },
                    () => {
                        if (
                            lastPreloadedTrackIdRef.current === preloadIdentity
                        ) {
                            lastPreloadedTrackIdRef.current = null;
                        }
                    },
                );
        },
        [lastPreloadedTrackIdRef, leaseController, ytMusicAuthenticatedRef],
    );

    // Preload next track for gapless playback (music only)
    useEffect(() => {
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
        leaseController,
        lastPreloadedTrackIdRef,
        preloadTrack,
    ]);

    return preloadTrack;
}
