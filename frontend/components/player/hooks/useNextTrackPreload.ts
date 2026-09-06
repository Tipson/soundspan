import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Podcast, Track } from "@/lib/audio-state-context";
import type { QueueItem } from "@/lib/queue-item";
import { api } from "@/lib/api";
import {
    acquireDeviceOfflinePlaybackSource,
    hasDeviceOfflinePlaybackCopy,
    resolveDeviceOfflineMediaIdentity,
} from "@/features/device-offline/playbackResolver";
import {
    getNextTrackInfo,
    isRetiredProviderTrack,
    resolveDirectTrackSourceType,
} from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import { resolveNetworkNextTrackPreloadDecision } from "@/lib/audio-engine/nextTrackPreloadPolicy";
import { resolveRemoteStreamFormat } from "../audioPlaybackOrchestratorPolicy";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { usePlaybackSourceLeaseController } from "./playbackSourceLeaseController";
import { observeIosBackgroundTrackHandoff } from "../iosBackgroundTrackHandoffController";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import {
    AdaptiveQueueWarmupCoordinator,
    resolveUpcomingQueueTracks,
    type NetworkConnectionHints,
} from "@/lib/audio-engine/adaptiveQueueWarmup";
import type { AudioPreloadLease } from "@/lib/audio-engine/types";
import { frontendLogger } from "@/lib/logger";

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
    consumeReadyCurrentTrackPreload: (track: Track) => boolean;
}

function isVerifiedDevicePlaybackUrl(url: string): boolean {
    return url.startsWith("blob:") || url.includes("/__offline/audio/");
}

function resolveWarmableYtMusicVideoId(
    track: PreloadableTrack | Track | null | undefined,
): string | null {
    if (
        !track ||
        resolveDirectTrackSourceType(track) !== "ytmusic" ||
        hasDeviceOfflinePlaybackCopy(track)
    ) {
        return null;
    }
    return track.provider?.youtubeVideoId ?? track.youtubeVideoId ?? null;
}

function readConnectionHints(): NetworkConnectionHints {
    const connection =
        typeof navigator === "undefined"
            ? undefined
            : (
                  navigator as Navigator & {
                      connection?: {
                          saveData?: boolean;
                          effectiveType?: string;
                      };
                  }
              ).connection;
    return {
        saveData: connection?.saveData,
        effectiveType: connection?.effectiveType,
    };
}

function createWarmupOwnerId(): string {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return `player-${crypto.randomUUID()}`;
    }
    return `player-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
        enginePreloadLeaseRef,
        readyPreloadedTrackIdRef,
    } = refs;
    const leaseController = usePlaybackSourceLeaseController();
    const preloadRequestIdRef = useRef(0);
    const failedNetworkPreloadRef = useRef<{
        identity: string;
        sourceUrl: string;
        retryAt: number;
    } | null>(null);
    const readyCurrentTrackPreloadAtCommitRef = useRef<{
        identity: string;
        lease: AudioPreloadLease;
    } | null>(null);
    const pendingYtMusicPreloadRef = useRef<{
        requestId: number;
        identity: string;
        videoId: string;
        track: PreloadableTrack;
        reconcile: (
            immediateTrack: PreloadableTrack,
            immediateLease: AudioPreloadLease,
        ) => void;
    } | null>(null);
    const warmupCoordinatorRef = useRef<AdaptiveQueueWarmupCoordinator | null>(
        null,
    );
    useLayoutEffect(() => {
        const coordinator = new AdaptiveQueueWarmupCoordinator(
            createWarmupOwnerId(),
            (request, signal) =>
                api.reconcileYtMusicTailWarmup(request, signal),
            (error) =>
                frontendLogger.warn(
                    "[Player] Tail warmup reconcile failed:",
                    error,
                ),
        );
        warmupCoordinatorRef.current = coordinator;
        return () => {
            if (warmupCoordinatorRef.current === coordinator) {
                warmupCoordinatorRef.current = null;
            }
            coordinator.dispose();
        };
    }, []);

    useLayoutEffect(() => {
        // Snapshot readiness before this hook's passive queue effect replaces
        // the old next-track preload ahead of the parent's load effect.
        const currentIdentity =
            playbackType === "track" && currentTrack
                ? resolveDeviceOfflineMediaIdentity(currentTrack)
                : null;
        const preloadLease = enginePreloadLeaseRef.current;
        readyCurrentTrackPreloadAtCommitRef.current =
            currentIdentity &&
            preloadLease &&
            lastPreloadedTrackIdRef.current === currentIdentity &&
            readyPreloadedTrackIdRef.current === currentIdentity
                ? { identity: currentIdentity, lease: preloadLease }
                : null;
    }, [
        currentIndex,
        currentTrack,
        enginePreloadLeaseRef,
        lastPreloadedTrackIdRef,
        playbackType,
        readyPreloadedTrackIdRef,
    ]);

    const consumeReadyCurrentTrackPreload = useCallback(
        (track: Track): boolean => {
            const readyAtCommit = readyCurrentTrackPreloadAtCommitRef.current;
            readyCurrentTrackPreloadAtCommitRef.current = null;
            const expectedPreloadUrl =
                track.streamSource === "youtube" &&
                track.youtubeVideoId &&
                !hasDeviceOfflinePlaybackCopy(track)
                    ? api.getYtMusicStreamUrl(
                          track.youtubeVideoId,
                          undefined,
                          true,
                          "preload",
                      )
                    : null;
            return (
                readyAtCommit?.identity ===
                    resolveDeviceOfflineMediaIdentity(track) &&
                expectedPreloadUrl !== null &&
                readyAtCommit.lease.sourceUrl === expectedPreloadUrl
            );
        },
        [],
    );

    const reconcileAdaptiveWarmup = useCallback(
        (
            immediateTrack: PreloadableTrack,
            immediateLease: AudioPreloadLease | null,
        ) => {
            const upcoming = resolveUpcomingQueueTracks(
                queue,
                currentIndex,
                isShuffle,
                shuffleIndices,
                repeatMode,
                5,
            );
            const tailVideoIds = upcoming
                .slice(
                    upcoming[0] && upcoming[0].id === immediateTrack.id ? 1 : 0,
                )
                .map((track) =>
                    track.itemType === "episode"
                        ? null
                        : resolveWarmableYtMusicVideoId(track),
                )
                .filter((videoId): videoId is string => Boolean(videoId));
            void warmupCoordinatorRef.current?.reconcile({
                currentVideoId: resolveWarmableYtMusicVideoId(currentTrack),
                immediateVideoId: resolveWarmableYtMusicVideoId(immediateTrack),
                tailVideoIds,
                connection: readConnectionHints(),
                immediateLease,
                retainOnly: immediateLease === null,
            });
        },
        [
            currentIndex,
            currentTrack,
            isShuffle,
            queue,
            repeatMode,
            shuffleIndices,
        ],
    );

    const preloadTrack = useCallback(
        (
            nextTrack: PreloadableTrack,
            options: PreloadTrackOptions = {},
        ): void => {
            if (
                isRetiredProviderTrack(nextTrack) ||
                nextTrack.streamSource === "audius" ||
                nextTrack.provider?.source === "audius"
            ) {
                preloadRequestIdRef.current += 1;
                pendingYtMusicPreloadRef.current = null;
                enginePreloadLeaseRef.current?.cancel();
                enginePreloadLeaseRef.current = null;
                leaseController.release();
                lastPreloadedTrackIdRef.current = null;
                readyPreloadedTrackIdRef.current = null;
                void warmupCoordinatorRef.current?.clear();
                return;
            }
            const preloadIdentity =
                resolveDeviceOfflineMediaIdentity(nextTrack);
            const hasDeviceCopy = hasDeviceOfflinePlaybackCopy(nextTrack);
            const requestedYtMusicVideoId =
                nextTrack.streamSource === "youtube"
                    ? (nextTrack.youtubeVideoId ?? null)
                    : null;
            const expectedNetworkYtMusicPreloadUrl =
                requestedYtMusicVideoId && !hasDeviceCopy
                    ? api.getYtMusicStreamUrl(
                          requestedYtMusicVideoId,
                          undefined,
                          true,
                          "preload",
                      )
                    : null;
            const failedPreload = failedNetworkPreloadRef.current;
            if (
                failedPreload?.identity === preloadIdentity &&
                failedPreload.sourceUrl === expectedNetworkYtMusicPreloadUrl &&
                Date.now() < failedPreload.retryAt
            ) {
                // A failed speculative read must not be restarted by every
                // progress tick. Foreground playback has its own recovery.
                return;
            }
            if (preloadIdentity === lastPreloadedTrackIdRef.current) {
                const existingLease = enginePreloadLeaseRef.current;
                const existingLeaseMatchesSource =
                    expectedNetworkYtMusicPreloadUrl === null ||
                    existingLease?.sourceUrl ===
                        expectedNetworkYtMusicPreloadUrl;
                if (existingLease && existingLeaseMatchesSource) {
                    // The immediate item stayed stable, but a reorder may have
                    // replaced its tail. Reconcile a fresh generation without
                    // restarting the real browser preload.
                    reconcileAdaptiveWarmup(nextTrack, existingLease);
                    return;
                }
                const pendingPreload = pendingYtMusicPreloadRef.current;
                if (
                    !existingLease &&
                    requestedYtMusicVideoId !== null &&
                    pendingPreload?.identity === preloadIdentity &&
                    pendingPreload.videoId === requestedYtMusicVideoId
                ) {
                    // Time updates retain the same expensive device-source
                    // acquisition. A queue-only change refreshes the tail
                    // context consumed when that acquisition completes.
                    pendingPreload.track = nextTrack;
                    pendingPreload.reconcile = reconcileAdaptiveWarmup;
                    return;
                }
            }
            enginePreloadLeaseRef.current?.cancel();
            enginePreloadLeaseRef.current = null;
            readyPreloadedTrackIdRef.current = null;
            const requestId = ++preloadRequestIdRef.current;
            pendingYtMusicPreloadRef.current = null;
            const isCurrentRequest = () =>
                preloadRequestIdRef.current === requestId &&
                lastPreloadedTrackIdRef.current === preloadIdentity;

            // A YouTube Music preload starts a real sidecar spool job. The
            // default effect remains device-only; the timing policy opts one
            // network item in after current playback is confirmed, and the end
            // handler may do the same as an iOS audio-session fallback.
            if (
                nextTrack.streamSource === "youtube" &&
                !hasDeviceCopy &&
                !options.allowNetworkYouTube
            ) {
                leaseController.release();
                lastPreloadedTrackIdRef.current = null;
                readyPreloadedTrackIdRef.current = null;
                // Keep only existing work needed after this queue change.
                // Do not admit a new network preload before timing permits it.
                reconcileAdaptiveWarmup(nextTrack, null);
                return;
            }

            let streamUrl: string;
            let format: string | undefined = "mp3";

            if (
                nextTrack.streamSource === "youtube" &&
                nextTrack.youtubeVideoId
            ) {
                streamUrl =
                    expectedNetworkYtMusicPreloadUrl ??
                    api.getYtMusicStreamUrl(
                        nextTrack.youtubeVideoId,
                        undefined,
                        true,
                        "preload",
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
            if (requestedYtMusicVideoId !== null) {
                pendingYtMusicPreloadRef.current = {
                    requestId,
                    identity: preloadIdentity,
                    videoId: requestedYtMusicVideoId,
                    track: nextTrack,
                    reconcile: reconcileAdaptiveWarmup,
                };
            }
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
                        const pendingPreload =
                            pendingYtMusicPreloadRef.current?.requestId ===
                            requestId
                                ? pendingYtMusicPreloadRef.current
                                : null;
                        pendingYtMusicPreloadRef.current = null;
                        if (!resolvedUrl) {
                            lastPreloadedTrackIdRef.current = null;
                            readyPreloadedTrackIdRef.current = null;
                            void warmupCoordinatorRef.current?.clear();
                            return;
                        }
                        if (
                            nextTrack.streamSource === "youtube" &&
                            !options.allowNetworkYouTube &&
                            !isVerifiedDevicePlaybackUrl(resolvedUrl)
                        ) {
                            leaseController.release();
                            lastPreloadedTrackIdRef.current = null;
                            readyPreloadedTrackIdRef.current = null;
                            void warmupCoordinatorRef.current?.clear();
                            return;
                        }
                        const preloadLease = audioEngine.preload(
                            resolvedUrl,
                            format,
                        );
                        if (!preloadLease) {
                            leaseController.release();
                            lastPreloadedTrackIdRef.current = null;
                            readyPreloadedTrackIdRef.current = null;
                            return;
                        }
                        enginePreloadLeaseRef.current = preloadLease;
                        (pendingPreload?.reconcile ?? reconcileAdaptiveWarmup)(
                            pendingPreload?.track ?? nextTrack,
                            preloadLease,
                        );
                        void preloadLease.result.then((result) => {
                            if (
                                !isCurrentRequest() ||
                                enginePreloadLeaseRef.current !== preloadLease
                            ) {
                                return;
                            }
                            if (result.state === "ready") {
                                readyPreloadedTrackIdRef.current =
                                    preloadIdentity;
                                return;
                            }
                            if (
                                result.state === "failed" &&
                                expectedNetworkYtMusicPreloadUrl !== null
                            ) {
                                failedNetworkPreloadRef.current = {
                                    identity: preloadIdentity,
                                    sourceUrl: expectedNetworkYtMusicPreloadUrl,
                                    retryAt: Date.now() + 60_000,
                                };
                            }
                            enginePreloadLeaseRef.current = null;
                            lastPreloadedTrackIdRef.current = null;
                            readyPreloadedTrackIdRef.current = null;
                            leaseController.release();
                            void warmupCoordinatorRef.current?.clear();
                        });
                    },
                    () => {
                        if (isCurrentRequest()) {
                            pendingYtMusicPreloadRef.current = null;
                            lastPreloadedTrackIdRef.current = null;
                            readyPreloadedTrackIdRef.current = null;
                            void warmupCoordinatorRef.current?.clear();
                        }
                    },
                );
        },
        [
            enginePreloadLeaseRef,
            lastPreloadedTrackIdRef,
            leaseController,
            reconcileAdaptiveWarmup,
            readyPreloadedTrackIdRef,
        ],
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
            pendingYtMusicPreloadRef.current = null;
            enginePreloadLeaseRef.current?.cancel();
            enginePreloadLeaseRef.current = null;
            leaseController.release();
            lastPreloadedTrackIdRef.current = null;
            readyPreloadedTrackIdRef.current = null;
            void warmupCoordinatorRef.current?.clear();
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
            pendingYtMusicPreloadRef.current = null;
            enginePreloadLeaseRef.current?.cancel();
            enginePreloadLeaseRef.current = null;
            leaseController.release();
            lastPreloadedTrackIdRef.current = null;
            readyPreloadedTrackIdRef.current = null;
            void warmupCoordinatorRef.current?.clear();
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
        enginePreloadLeaseRef,
        leaseController,
        lastPreloadedTrackIdRef,
        preloadTrack,
        readyPreloadedTrackIdRef,
    ]);

    return {
        preloadTrack,
        preloadNetworkWhenDue,
        consumeReadyCurrentTrackPreload,
    };
}
