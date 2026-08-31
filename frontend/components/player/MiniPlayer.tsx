"use client";

import {
    useAudioControls,
    useAudioState,
    usePlaybackStatus,
} from "@/lib/audio-context";
import { usePlaybackProgress } from "@/lib/audio-playback-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { CachedImage } from "@/components/ui/CachedImage";
import { motion } from "framer-motion";
import {
    Play,
    Pause,
    Music as MusicIcon,
    Loader2,
    RefreshCw,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { clampTime } from "@/utils/formatTime";
import { CurrentTrackPreferenceButtons } from "@/components/player/CurrentTrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { ru } from "@/lib/i18n/ru";

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
    const { pause, resume, setPlayerMode } = useAudioControls();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const { title, subtitle, coverUrl, hasMedia } = useMediaInfo(100);
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
            <div
                className="mobile-player-surface pointer-events-auto overflow-hidden rounded-[14px]"
                data-player-layout="identity-like-play"
            >
                <div className="relative h-[2px] w-full bg-white/[0.08]">
                    <div
                        className="shell-signal-progress h-full transition-[width] duration-150"
                        style={{ width: `${progress}%` }}
                    />
                </div>

                <div
                    className="flex min-h-[64px] items-center gap-2 px-3 py-2"
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
                    aria-label={ru.player.open}
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
                                <p className="truncate text-sm font-semibold text-error">
                                    Ошибка воспроизведения
                                </p>
                                <p className="truncate text-xs text-error/75">
                                    Нажмите «Повторить», чтобы переподключиться
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="truncate text-[13px] font-semibold text-content min-[360px]:text-sm">
                                    {title}
                                </p>
                                <p className="mt-0.5 truncate text-xs text-content-muted">
                                    {subtitle}
                                </p>
                            </>
                        )}
                    </div>

                    {playbackType === "track" && currentTrack?.id && (
                        <div
                            className="hidden flex-shrink-0 items-center min-[360px]:flex"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            role="group"
                            aria-label={ru.player.preference}
                        >
                            <CurrentTrackPreferenceButtons
                                trackId={currentTrack.id}
                                mode="up-only"
                                buttonSizeClassName="h-11 w-11"
                                iconSizeClassName="h-4 w-4"
                                metadata={buildPreferenceMetadata(currentTrack)}
                            />
                        </div>
                    )}

                    <div
                        className="flex flex-shrink-0 items-center"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        role="group"
                        aria-label={ru.player.controls}
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
                                    ? "bg-error text-content hover:brightness-110"
                                    : isBuffering
                                      ? "bg-content/80 text-surface"
                                      : "bg-content text-surface hover:scale-105",
                            )}
                            aria-label={
                                audioError
                                    ? ru.player.retry
                                    : isBuffering
                                      ? ru.player.buffering
                                      : isPlaying
                                        ? ru.common.pause
                                        : ru.common.play
                            }
                            title={
                                audioError
                                    ? ru.player.retry
                                    : isBuffering
                                      ? ru.player.buffering
                                      : isPlaying
                                        ? ru.common.pause
                                        : ru.common.play
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
                    </div>
                </div>
            </div>
        </div>
    );
}
