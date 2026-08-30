"use client";

import {
    useAudioControls,
    useAudioState,
    usePlaybackStatus,
} from "@/lib/audio-context";
import { usePlaybackProgress } from "@/lib/audio-playback-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { useStreamBitrate } from "@/hooks/useStreamBitrate";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { CachedImage } from "@/components/ui/CachedImage";
import { motion } from "framer-motion";
import {
    Play,
    Pause,
    SkipForward,
    Music as MusicIcon,
    Loader2,
    RefreshCw,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { clampTime } from "@/utils/formatTime";
import { SyncBadge } from "@/components/player/SyncBadge";
import { CurrentTrackPreferenceButtons } from "@/components/player/CurrentTrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { PlaybackQualityBadgeWithStats } from "@/components/player/PlaybackQualityBadgeWithStats";

/**
 * Renders the MiniPlayer component.
 */
export function MiniPlayer() {
    const { currentTrack, currentAudiobook, currentPodcast, playbackType } =
        useAudioState();
    const {
        isPlaying,
        isBuffering,
        duration: playbackDuration,
        audioError,
        clearAudioError,
    } = usePlaybackStatus();
    // The mini player renders the progress bar: legitimate clock consumer.
    const { currentTime } = usePlaybackProgress();
    const { pause, resume, next, setPlayerMode } = useAudioControls();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const { title, subtitle, coverUrl, hasMedia } = useMediaInfo(100);
    const { qualityBadge } = useStreamBitrate();
    const currentMediaId =
        currentTrack?.id ||
        currentAudiobook?.id ||
        currentPodcast?.id ||
        "default";
    const artworkLayoutId = `mobile-player-artwork-${currentMediaId}`;

    // Calculate progress percentage
    const duration = (() => {
        if (playbackType === "podcast" && currentPodcast?.duration) {
            return currentPodcast.duration;
        }
        if (playbackType === "audiobook" && currentAudiobook?.duration) {
            return currentAudiobook.duration;
        }
        return (
            playbackDuration ||
            currentTrack?.duration ||
            currentAudiobook?.duration ||
            currentPodcast?.duration ||
            0
        );
    })();

    // CRITICAL: Clamp currentTime to prevent invalid progress display
    const clampedCurrentTime = clampTime(currentTime, duration);

    const progress =
        duration > 0
            ? Math.min(100, Math.max(0, (clampedCurrentTime / duration) * 100))
            : 0;

    if (!isMobileOrTablet || !hasMedia) {
        return null;
    }

    return (
        <div
            data-mobile-player="dock"
            className="mobile-player-dock pointer-events-none fixed z-50"
        >
            <div className="mobile-player-surface pointer-events-auto overflow-hidden rounded-2xl">
                <div className="relative h-[2px] w-full bg-white/[0.08]">
                    <div
                        className="shell-signal-progress h-full transition-[width] duration-150"
                        style={{ width: `${progress}%` }}
                    />
                </div>

                <div
                    className="flex min-h-[70px] items-center gap-2 px-3 py-2"
                    style={{
                        paddingLeft: "calc(0.75rem + var(--safe-area-left))",
                        paddingRight: "calc(0.75rem + var(--safe-area-right))",
                    }}
                    onClick={() => setPlayerMode("overlay")}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setPlayerMode("overlay");
                        }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label="Open full player"
                >
                    <motion.div
                        layoutId={artworkLayoutId}
                        transition={{
                            type: "spring",
                            stiffness: 320,
                            damping: 34,
                        }}
                        className="relative h-11 w-11 flex-shrink-0 overflow-hidden rounded-xl bg-black/30 ring-1 ring-white/10"
                    >
                        {coverUrl ? (
                            <CachedImage
                                src={coverUrl}
                                alt={title}
                                fill
                                sizes="44px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="flex h-full w-full items-center justify-center">
                                <MusicIcon className="h-5 w-5 text-gray-400" />
                            </div>
                        )}
                    </motion.div>

                    <div className="min-w-0 flex-1">
                        {audioError ? (
                            <>
                                <p className="truncate text-sm font-semibold text-red-300">
                                    Playback Error
                                </p>
                                <p className="truncate text-xs text-red-200/70">
                                    Tap retry to reconnect
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="truncate text-[13px] font-semibold text-white min-[360px]:text-sm">
                                    {title}
                                </p>
                                <div className="mt-0.5 flex items-center gap-1.5">
                                    <p className="truncate text-xs text-gray-300/80">
                                        {subtitle}
                                    </p>
                                    {qualityBadge ? (
                                        <span className="hidden min-[400px]:inline-flex">
                                            <PlaybackQualityBadgeWithStats
                                                badge={qualityBadge}
                                                size="mini"
                                            />
                                        </span>
                                    ) : null}
                                    <span className="hidden min-[400px]:inline-flex">
                                        <SyncBadge compact />
                                    </span>
                                </div>
                            </>
                        )}
                    </div>

                    {playbackType === "track" && currentTrack?.id && (
                        <div
                            className="hidden flex-shrink-0 items-center min-[360px]:flex"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            role="group"
                            aria-label="Track preference"
                        >
                            <CurrentTrackPreferenceButtons
                                trackId={currentTrack.id}
                                mode="both"
                                buttonSizeClassName="h-11 w-11"
                                iconSizeClassName="h-4 w-4"
                                metadata={buildPreferenceMetadata(currentTrack)}
                            />
                        </div>
                    )}

                    <div
                        className="flex flex-shrink-0 items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        role="group"
                        aria-label="Playback controls"
                    >
                        <button
                            onClick={() => {
                                if (audioError) {
                                    clearAudioError();
                                    resume();
                                } else if (!isBuffering) {
                                    if (isPlaying) {
                                        pause();
                                    } else {
                                        resume();
                                    }
                                }
                            }}
                            className={cn(
                                "h-11 w-11 rounded-full transition shadow-md flex items-center justify-center",
                                audioError
                                    ? "bg-red-500 text-white hover:bg-red-400"
                                    : isBuffering
                                      ? "bg-white/80 text-black"
                                      : "bg-white text-black hover:scale-105",
                            )}
                            aria-label={
                                audioError
                                    ? "Retry playback"
                                    : isBuffering
                                      ? "Buffering..."
                                      : isPlaying
                                        ? "Pause"
                                        : "Play"
                            }
                            title={
                                audioError
                                    ? "Retry playback"
                                    : isBuffering
                                      ? "Buffering..."
                                      : isPlaying
                                        ? "Pause"
                                        : "Play"
                            }
                        >
                            {audioError ? (
                                <RefreshCw className="h-5 w-5" />
                            ) : isBuffering ? (
                                <Loader2 className="h-5 w-5 animate-spin" />
                            ) : isPlaying ? (
                                <Pause className="h-5 w-5" />
                            ) : (
                                <Play className="ml-0.5 h-5 w-5" />
                            )}
                        </button>
                        <button
                            onClick={() => next()}
                            className="hidden h-11 w-11 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white min-[380px]:flex"
                            aria-label="Next track"
                            title="Next track"
                        >
                            <SkipForward className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
