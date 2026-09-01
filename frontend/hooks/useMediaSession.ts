import {
    useAudioControls,
    useAudioState,
    usePlaybackStatus,
} from "@/lib/audio-context";
import { usePlaybackProgress } from "@/lib/audio-playback-context";
import { useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { ru } from "@/lib/i18n/ru";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";

/**
 * Media Session API integration for OS-level media controls
 *
 * Features:
 * - Lock screen controls (iOS/Android)
 * - Media keys (play/pause, next, previous)
 * - Now playing notification
 * - Album art display
 * - Seek controls (on supported platforms)
 */
export function useMediaSession() {
    const { currentTrack, currentAudiobook, currentPodcast, playbackType } =
        useAudioState();
    const { isPlaying } = usePlaybackStatus();
    // The OS media UI shows the playback position: legitimate clock consumer
    // (this hook's host renders null, so the tick re-render is cheap).
    const { currentTime } = usePlaybackProgress();
    const { pause, resume, next, previous, seek, skipForward, skipBackward } =
        useAudioControls();
    const hasActiveMedia = Boolean(
        currentTrack || currentAudiobook || currentPodcast,
    );

    // Track if this device has initiated playback locally
    // Prevents cross-device media session interference from state sync
    const hasPlayedLocallyRef = useRef(false);

    // Set flag when playback starts on this device
    useEffect(() => {
        if (isPlaying) {
            hasPlayedLocallyRef.current = true;
        }
    }, [isPlaying]);

    // Reset flag when all media is cleared
    useEffect(() => {
        if (!hasActiveMedia) {
            hasPlayedLocallyRef.current = false;
        }
    }, [hasActiveMedia]);

    // Convert relative URLs to absolute (required for iOS)
    const getAbsoluteUrl = useCallback((url: string): string => {
        if (!url) return "";
        if (url.startsWith("http://") || url.startsWith("https://")) {
            return url;
        }
        // Construct absolute URL
        if (typeof window !== "undefined") {
            return `${window.location.origin}${url}`;
        }
        return url;
    }, []);

    useEffect(() => {
        // Check if Media Session API is supported
        if (!("mediaSession" in navigator)) {
            sharedFrontendLogger.warn(
                "[MediaSession] Media Session API not supported",
            );
            return;
        }

        // Only set metadata if this device has initiated playback
        // Prevents cross-device interference from state sync
        if (!hasActiveMedia || !hasPlayedLocallyRef.current) {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = "none";
            return;
        }

        // Update metadata when track/audiobook/podcast changes
        if (playbackType === "track" && currentTrack) {
            const coverUrl = currentTrack.album?.coverArt
                ? getAbsoluteUrl(
                      api.getCoverArtUrl(currentTrack.album.coverArt, 512),
                  )
                : undefined;

            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentTrack.title,
                artist: currentTrack.artist?.name || ru.common.unknownArtist,
                album: currentTrack.album?.title || ru.common.unknownAlbum,
                artwork: coverUrl
                    ? [
                          { src: coverUrl, sizes: "96x96", type: "image/jpeg" },
                          {
                              src: coverUrl,
                              sizes: "128x128",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "192x192",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "256x256",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "384x384",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "512x512",
                              type: "image/jpeg",
                          },
                      ]
                    : undefined,
            });
        } else if (playbackType === "audiobook" && currentAudiobook) {
            const coverUrl = currentAudiobook.coverUrl
                ? getAbsoluteUrl(
                      api.getCoverArtUrl(currentAudiobook.coverUrl, 512),
                  )
                : undefined;

            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentAudiobook.title,
                artist: currentAudiobook.author,
                album: currentAudiobook.narrator
                    ? `Читает: ${currentAudiobook.narrator}`
                    : "Аудиокнига",
                artwork: coverUrl
                    ? [
                          { src: coverUrl, sizes: "96x96", type: "image/jpeg" },
                          {
                              src: coverUrl,
                              sizes: "128x128",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "192x192",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "256x256",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "384x384",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "512x512",
                              type: "image/jpeg",
                          },
                      ]
                    : undefined,
            });
        } else if (playbackType === "podcast" && currentPodcast) {
            const coverUrl = currentPodcast.coverUrl
                ? getAbsoluteUrl(
                      api.getCoverArtUrl(currentPodcast.coverUrl, 512),
                  )
                : undefined;

            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentPodcast.title,
                artist: currentPodcast.podcastTitle,
                album: "Подкаст",
                artwork: coverUrl
                    ? [
                          { src: coverUrl, sizes: "96x96", type: "image/jpeg" },
                          {
                              src: coverUrl,
                              sizes: "128x128",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "192x192",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "256x256",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "384x384",
                              type: "image/jpeg",
                          },
                          {
                              src: coverUrl,
                              sizes: "512x512",
                              type: "image/jpeg",
                          },
                      ]
                    : undefined,
            });
        } else {
            // Clear metadata when nothing is playing
            navigator.mediaSession.metadata = null;
        }

        // Update playback state
        navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    }, [
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        hasActiveMedia,
        getAbsoluteUrl,
    ]);

    useEffect(() => {
        if (!("mediaSession" in navigator)) return;

        // Only register handlers if this device has initiated playback
        // Prevents cross-device interference from state sync
        if (!hasActiveMedia || !hasPlayedLocallyRef.current) {
            return;
        }

        // Register action handlers
        navigator.mediaSession.setActionHandler("play", () => {
            // iOS may throttle React effects while the PWA is backgrounded.
            // Drive the native element inside the lock-screen gesture before
            // synchronizing declarative playback state, otherwise WebKit can
            // advance the Media Session clock without audible output.
            audioEngine.play();
            resume();
        });

        navigator.mediaSession.setActionHandler("pause", () => {
            // Keep pause equally immediate so the same background session
            // cannot leave a short sample playing while React is suspended.
            audioEngine.pause();
            pause();
        });

        navigator.mediaSession.setActionHandler("previoustrack", () => {
            if (playbackType === "track") {
                previous();
            } else {
                // For audiobooks/podcasts, seek backward 30s
                skipBackward(30);
            }
        });

        navigator.mediaSession.setActionHandler("nexttrack", () => {
            if (playbackType === "track") {
                next();
            } else {
                // For audiobooks/podcasts, seek forward 30s
                skipForward(30);
            }
        });

        // Seek controls (may not be supported on all platforms)
        try {
            navigator.mediaSession.setActionHandler(
                "seekbackward",
                (details) => {
                    skipBackward(details.seekOffset || 10);
                },
            );

            navigator.mediaSession.setActionHandler(
                "seekforward",
                (details) => {
                    skipForward(details.seekOffset || 10);
                },
            );

            navigator.mediaSession.setActionHandler("seekto", (details) => {
                if (details.seekTime !== undefined) {
                    seek(details.seekTime);
                }
            });
        } catch {
            // Seek actions not supported on this platform
        }

        // Cleanup
        return () => {
            if ("mediaSession" in navigator) {
                navigator.mediaSession.setActionHandler("play", null);
                navigator.mediaSession.setActionHandler("pause", null);
                navigator.mediaSession.setActionHandler("previoustrack", null);
                navigator.mediaSession.setActionHandler("nexttrack", null);
                try {
                    navigator.mediaSession.setActionHandler(
                        "seekbackward",
                        null,
                    );
                    navigator.mediaSession.setActionHandler(
                        "seekforward",
                        null,
                    );
                    navigator.mediaSession.setActionHandler("seekto", null);
                } catch {
                    // Ignore cleanup errors
                }
            }
        };
    }, [
        pause,
        resume,
        next,
        previous,
        seek,
        skipForward,
        skipBackward,
        isPlaying,
        playbackType,
        hasActiveMedia,
    ]);

    // Update position state for scrubbing on lock screen
    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        if (!("setPositionState" in navigator.mediaSession)) return;

        const duration =
            currentTrack?.duration ||
            currentAudiobook?.duration ||
            currentPodcast?.duration;

        if (
            !hasActiveMedia ||
            !hasPlayedLocallyRef.current ||
            !duration ||
            currentTime === undefined
        ) {
            try {
                navigator.mediaSession.setPositionState();
            } catch (error) {
                sharedFrontendLogger.warn(
                    "[MediaSession] Failed to clear position state:",
                    error,
                );
            }
            return;
        }

        try {
            navigator.mediaSession.setPositionState({
                duration,
                playbackRate: 1,
                position: Math.min(currentTime, duration),
            });
        } catch (error) {
            // Some browsers may not support position state
            sharedFrontendLogger.warn(
                "[MediaSession] Failed to set position state:",
                error,
            );
        }
    }, [
        currentTime,
        currentTrack,
        currentAudiobook,
        currentPodcast,
        isPlaying,
        hasActiveMedia,
    ]);
}
