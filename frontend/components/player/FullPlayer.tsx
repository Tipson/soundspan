"use client";

import { useAudioState } from "@/lib/audio-state-context";
import {
    usePlaybackStatus,
    usePlaybackProgress,
} from "@/lib/audio-playback-context";
import { useAudioVolumeMode } from "@/lib/audio-volume-mode-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { useStreamBitrate } from "@/hooks/useStreamBitrate";
import { CachedImage } from "@/components/ui/CachedImage";
import Link from "next/link";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    RotateCcw,
    RotateCw,
    Volume2,
    VolumeX,
    ChevronUp,
    ChevronDown,
    Music as MusicIcon,
    Loader2,
    RefreshCw,
    Repeat,
    Repeat1,
    Shuffle,
} from "lucide-react";
import { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/utils/cn";
import { formatTime, clampTime } from "@/utils/formatTime";
import { SeekSlider } from "./SeekSlider";
import { SyncBadge } from "@/components/player/SyncBadge";
import { CurrentTrackPreferenceButtons } from "./CurrentTrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { PlaybackQualityBadgeWithStats } from "./PlaybackQualityBadgeWithStats";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { PeerBadge } from "@/components/ui/PeerBadge";
import { ru } from "@/lib/i18n/ru";

/**
 * FullPlayer - UI-only component for desktop bottom player
 * Does NOT manage audio element - that's handled by AudioElement component
 */
export function FullPlayer() {
    // Use split contexts to avoid re-rendering on every currentTime update
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        queue,
        isShuffle,
        repeatMode,
        vibeMode,
    } = useAudioState();
    const { volume, isMuted, playerMode } = useAudioVolumeMode();

    const {
        isPlaying,
        isBuffering,
        duration: playbackDuration,
        canSeek,
        downloadProgress,
        audioError,
        clearAudioError,
    } = usePlaybackStatus();
    // FullPlayer displays the position, so it is a legitimate clock consumer.
    const { currentTime } = usePlaybackProgress();

    const {
        pause,
        resume,
        next,
        previous,
        setPlayerMode,
        returnToPreviousMode,
        seek,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
        skipForward,
        skipBackward,
    } = useAudioControls();
    const preferenceTrackId =
        playbackType === "track" ? currentTrack?.id : undefined;

    const duration = (() => {
        // Prefer canonical durations for long-form media to avoid stale/misreported playbackDuration.
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

    // For audiobooks/podcasts, show saved progress even before playback starts
    // This provides immediate visual feedback of where the user left off
    const displayTime = (() => {
        let time = currentTime;

        // If we're actively playing or have seeked, use the live currentTime
        if (time <= 0) {
            // Otherwise, show saved progress for audiobooks/podcasts
            if (
                playbackType === "audiobook" &&
                currentAudiobook?.progress?.currentTime
            ) {
                time = currentAudiobook.progress.currentTime;
            } else if (
                playbackType === "podcast" &&
                currentPodcast?.progress?.currentTime
            ) {
                time = currentPodcast.progress.currentTime;
            }
        }

        // CRITICAL: Clamp to duration to prevent display of invalid times
        return clampTime(time, duration);
    })();

    const progress =
        duration > 0
            ? Math.min(100, Math.max(0, (displayTime / duration) * 100))
            : 0;

    const handleSeek = (time: number) => {
        seek(time);
    };

    const handlePlayPauseClick = () => {
        if (audioError) {
            clearAudioError();
            resume();
            return;
        }

        if (isBuffering) return;
        if (isPlaying) {
            pause();
            return;
        }
        resume();
    };

    const { title, subtitle, coverUrl, artistLink, mediaLink, hasMedia } =
        useMediaInfo(100);
    const isLongForm =
        playbackType === "podcast" || playbackType === "audiobook";
    const { qualityBadge } = useStreamBitrate();
    const repeatLabel =
        repeatMode === "one"
            ? ru.player.repeatOne
            : repeatMode === "all"
              ? ru.player.repeatAll
              : ru.player.repeatOff;

    // Determine if seeking is allowed
    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseInt(e.target.value) / 100;
        setVolume(newVolume);
    };

    // Volume popup state
    const [showVolumePopup, setShowVolumePopup] = useState(false);
    const volumePopupRef = useRef<HTMLDivElement>(null);
    const volumeHoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
    );

    const handleVolumeMouseEnter = useCallback(() => {
        if (volumeHoverTimeoutRef.current) {
            clearTimeout(volumeHoverTimeoutRef.current);
            volumeHoverTimeoutRef.current = null;
        }
        setShowVolumePopup(true);
    }, []);

    const handleVolumeMouseLeave = useCallback(() => {
        volumeHoverTimeoutRef.current = setTimeout(() => {
            setShowVolumePopup(false);
        }, 300);
    }, []);

    // Click on open space toggles overlay player on/off
    const handleBarClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            const target = e.target as HTMLElement;
            // Only trigger on the bar container divs themselves, not any child interactive elements
            if (
                target.closest(
                    "button, a, input, span, p, h4, img, svg, [role='slider'], [data-seek-zone]",
                )
            )
                return;
            if (!hasMedia) return;
            if (playerMode === "overlay") {
                returnToPreviousMode();
            } else {
                setPlayerMode("overlay");
            }
        },
        [hasMedia, playerMode, setPlayerMode, returnToPreviousMode],
    );

    // Close volume popup on outside click
    useEffect(() => {
        if (!showVolumePopup) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (
                volumePopupRef.current &&
                !volumePopupRef.current.contains(e.target as Node)
            ) {
                setShowVolumePopup(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [showVolumePopup]);

    const playerDiagnostics = qualityBadge ? (
        <div
            className="mt-1 flex items-center justify-between gap-3 border-t border-white/10 px-2 py-2"
            data-player-diagnostics="overflow"
        >
            <span className="text-[11px] font-medium text-content-muted">
                {ru.player.stream}
            </span>
            <PlaybackQualityBadgeWithStats badge={qualityBadge} size="mini" />
        </div>
    ) : null;

    return (
        <footer
            className="desktop-player-dock relative isolate flex-shrink-0"
            data-player-surface="desktop"
            aria-label="Плеер"
        >
            <div className="desktop-player-surface relative h-32 overflow-visible">
                {coverUrl && hasMedia ? (
                    <div
                        className="pointer-events-none absolute inset-0 overflow-hidden"
                        aria-hidden="true"
                        data-player-artwork-atmosphere
                    >
                        <CachedImage
                            key={`player-atmosphere-${coverUrl}`}
                            src={coverUrl}
                            alt=""
                            fill
                            sizes="100vw"
                            className="scale-125 object-cover opacity-[0.5] blur-3xl saturate-150"
                            priority
                            unoptimized
                        />
                    </div>
                ) : null}
                <div
                    className="pointer-events-none absolute inset-0 bg-gradient-to-r from-warning/30 via-ai/15 to-brand/25"
                    aria-hidden="true"
                    data-player-spectral-glow
                />
                <div
                    className="pointer-events-none absolute inset-0 bg-black/55 backdrop-blur-2xl"
                    aria-hidden="true"
                    data-player-scrim
                />
                <div
                    className={cn(
                        "desktop-player-layout relative z-10 grid h-full grid-cols-[minmax(240px,1fr)_minmax(360px,1.35fr)_minmax(240px,1fr)] grid-rows-[76px_36px] items-center gap-x-6 px-6 py-2",
                        hasMedia && "cursor-pointer",
                    )}
                    data-player-layout="identity-transport-actions"
                    data-player-control-budget={
                        isLongForm
                            ? "longform-5-utilities-4"
                            : "music-5-utilities-4"
                    }
                    onClick={handleBarClick}
                >
                    <div
                        className="row-span-2 flex min-w-0 items-center gap-4"
                        data-player-region="identity"
                        aria-label="Сейчас играет"
                    >
                        {mediaLink ? (
                            <Link
                                href={mediaLink}
                                prefetch={false}
                                className="group relative h-[88px] w-[88px] flex-shrink-0"
                            >
                                <div className="absolute inset-0 rounded-[10px] bg-white/15 opacity-0 blur-md transition-opacity duration-200 group-hover:opacity-100" />
                                <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[10px] bg-surface-hover shadow-lg ring-1 ring-white/10">
                                    {coverUrl ? (
                                        <CachedImage
                                            key={coverUrl}
                                            src={coverUrl}
                                            alt={title}
                                            fill
                                            sizes="88px"
                                            className="object-cover"
                                            priority
                                            unoptimized
                                        />
                                    ) : (
                                        <MusicIcon className="h-7 w-7 text-content-muted" />
                                    )}
                                </div>
                            </Link>
                        ) : (
                            <div className="relative h-[88px] w-[88px] flex-shrink-0">
                                <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[10px] bg-surface-hover shadow-lg ring-1 ring-white/10">
                                    {coverUrl ? (
                                        <CachedImage
                                            key={coverUrl}
                                            src={coverUrl}
                                            alt={title}
                                            fill
                                            sizes="88px"
                                            className="object-cover"
                                            priority
                                            unoptimized
                                        />
                                    ) : (
                                        <MusicIcon className="h-7 w-7 text-content-muted" />
                                    )}
                                </div>
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            {mediaLink ? (
                                <Link
                                    href={mediaLink}
                                    prefetch={false}
                                    className="block min-w-0 hover:underline"
                                >
                                    <h4 className="truncate text-base font-semibold leading-6 text-content">
                                        {title}
                                    </h4>
                                </Link>
                            ) : (
                                <h4 className="truncate text-base font-semibold leading-6 text-content">
                                    {title}
                                </h4>
                            )}
                            <div className="flex min-w-0 items-center gap-2">
                                {artistLink ? (
                                    <Link
                                        href={artistLink}
                                        prefetch={false}
                                        className="min-w-0 hover:underline"
                                    >
                                        <p className="truncate text-[13px] leading-5 text-content-muted">
                                            {subtitle}
                                        </p>
                                    </Link>
                                ) : mediaLink ? (
                                    <Link
                                        href={mediaLink}
                                        prefetch={false}
                                        className="min-w-0 hover:underline"
                                    >
                                        <p className="truncate text-[13px] leading-5 text-content-muted">
                                            {subtitle}
                                        </p>
                                    </Link>
                                ) : (
                                    <p className="truncate text-[13px] leading-5 text-content-muted">
                                        {subtitle}
                                    </p>
                                )}
                                {currentTrack?.source === "federated" &&
                                    currentTrack.peer && (
                                        <PeerBadge
                                            peerName={currentTrack.peer.name}
                                            online={currentTrack.peer.online}
                                        />
                                    )}
                                <SyncBadge compact />
                            </div>
                        </div>
                    </div>

                    <div
                        className="col-start-2 row-start-1 flex items-center justify-center self-end"
                        data-player-region="transport"
                        data-player-level="controls"
                        aria-label={ru.player.controls}
                    >
                        <div
                            className="player-transport flex items-center gap-2 xl:gap-3"
                            role="group"
                            aria-label={ru.player.controls}
                            data-player-control-group="primary"
                        >
                            {!isLongForm && (
                                <button
                                    onClick={toggleShuffle}
                                    className={cn(
                                        "player-control transition-colors",
                                        isShuffle
                                            ? "bg-white/10 text-brand-hover"
                                            : "text-content-muted hover:text-content",
                                    )}
                                    disabled={!hasMedia || vibeMode}
                                    aria-label={ru.player.shuffle}
                                    aria-pressed={isShuffle}
                                    title={ru.player.shuffle}
                                    data-player-control="shuffle"
                                >
                                    <Shuffle className="h-5 w-5" />
                                </button>
                            )}

                            {isLongForm && (
                                <button
                                    onClick={() => skipBackward(15)}
                                    className="player-control text-content-muted hover:text-content"
                                    disabled={!hasMedia || !canSeek}
                                    aria-label={ru.player.skipBack15}
                                    title={ru.player.skipBack15}
                                >
                                    <RotateCcw className="h-[18px] w-[18px]" />
                                </button>
                            )}

                            <button
                                onClick={previous}
                                className="player-control text-content-muted hover:text-content"
                                disabled={!hasMedia || queue.length === 0}
                                aria-label={ru.player.previous}
                                title={ru.player.previous}
                            >
                                <SkipBack className="w-6 h-6" />
                            </button>

                            <button
                                onClick={handlePlayPauseClick}
                                className={cn(
                                    "player-control-primary group relative flex h-12 w-12 items-center justify-center rounded-full",
                                    audioError
                                        ? "bg-error text-content hover:scale-[1.04] hover:brightness-110"
                                        : hasMedia && !isBuffering
                                          ? "bg-content text-surface hover:scale-[1.04] shadow-lg shadow-black/25"
                                          : isBuffering
                                            ? "bg-content/80 text-surface"
                                            : "cursor-not-allowed bg-surface-active text-content-disabled",
                                )}
                                disabled={!hasMedia || isBuffering}
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
                                {hasMedia && !isBuffering && !audioError && (
                                    <div className="absolute inset-0 rounded-full bg-content blur-md opacity-0 transition-opacity duration-200 group-hover:opacity-30" />
                                )}
                                {audioError ? (
                                    <RefreshCw className="w-6 h-6 relative z-10" />
                                ) : isBuffering ? (
                                    <Loader2 className="w-6 h-6 animate-spin relative z-10" />
                                ) : isPlaying ? (
                                    <Pause className="w-6 h-6 relative z-10" />
                                ) : (
                                    <Play className="w-6 h-6 ml-0.5 relative z-10" />
                                )}
                            </button>

                            <button
                                onClick={next}
                                className="player-control text-content-muted hover:text-content"
                                disabled={!hasMedia || queue.length === 0}
                                aria-label={ru.player.next}
                                title={ru.player.next}
                            >
                                <SkipForward className="w-6 h-6" />
                            </button>

                            {isLongForm && (
                                <button
                                    onClick={() => skipForward(15)}
                                    className="player-control text-content-muted hover:text-content"
                                    disabled={!hasMedia || !canSeek}
                                    aria-label={ru.player.skipForward15}
                                    title={ru.player.skipForward15}
                                >
                                    <RotateCw className="h-[18px] w-[18px]" />
                                </button>
                            )}

                            {!isLongForm && (
                                <button
                                    onClick={toggleRepeat}
                                    className={cn(
                                        "player-control transition-colors",
                                        repeatMode !== "off"
                                            ? "bg-white/10 text-brand-hover"
                                            : "text-content-muted hover:text-content",
                                    )}
                                    disabled={!hasMedia}
                                    aria-label={repeatLabel}
                                    aria-pressed={repeatMode !== "off"}
                                    title={repeatLabel}
                                    data-player-control="repeat"
                                    data-repeat-mode={repeatMode}
                                >
                                    {repeatMode === "one" ? (
                                        <Repeat1 className="h-5 w-5" />
                                    ) : (
                                        <Repeat className="h-5 w-5" />
                                    )}
                                </button>
                            )}
                        </div>
                    </div>

                    <div
                        className="col-start-2 row-start-2 flex min-w-0 items-center gap-3 self-start"
                        data-player-level="timeline"
                        data-seek-zone
                    >
                        <span
                            className="w-10 flex-shrink-0 text-right text-[11px] font-medium tabular-nums text-content-secondary"
                            data-player-time="current"
                        >
                            {formatTime(displayTime)}
                        </span>
                        <div className="min-w-0 flex-1">
                            <SeekSlider
                                progress={progress}
                                duration={duration}
                                currentTime={displayTime}
                                onSeek={handleSeek}
                                canSeek={canSeek}
                                hasMedia={hasMedia}
                                downloadProgress={downloadProgress}
                                variant="minimal"
                                alwaysShowHandle
                                handleClassName="h-2.5 w-2.5 shadow-xl shadow-black/50"
                                className="h-[3px]"
                                hitZoneClassName="py-2"
                            />
                        </div>
                        <span
                            className="w-10 flex-shrink-0 text-[11px] font-medium tabular-nums text-content-secondary"
                            data-player-time="duration"
                        >
                            {formatTime(duration)}
                        </span>
                    </div>

                    <div
                        className="player-utilities col-start-3 row-span-2 row-start-1 flex min-w-0 items-center justify-end gap-1"
                        data-player-region="actions"
                        data-player-control-group="utilities"
                        aria-label="Действия с текущим треком"
                    >
                        <div className="flex items-center gap-1">
                            {currentTrack && playbackType === "track" ? (
                                <CurrentTrackPreferenceButtons
                                    trackId={preferenceTrackId}
                                    mode="both"
                                    buttonSizeClassName="h-10 w-10"
                                    iconSizeClassName="h-[18px] w-[18px]"
                                    metadata={buildPreferenceMetadata(
                                        currentTrack,
                                    )}
                                />
                            ) : null}

                            {currentTrack && playbackType === "track" && (
                                <TrackOverflowMenu
                                    track={currentTrack}
                                    showPlayNext={false}
                                    triggerClassName="!flex !h-10 !w-10 !items-center !justify-center !p-0 !opacity-100 text-content-muted hover:text-content"
                                    menuClassName="bottom-full top-auto mb-1 mt-0 z-[10001]"
                                    extraItemsAfter={playerDiagnostics}
                                />
                            )}

                            <div
                                ref={volumePopupRef}
                                className="relative z-[10000] flex items-center justify-center"
                                onMouseEnter={handleVolumeMouseEnter}
                                onMouseLeave={handleVolumeMouseLeave}
                            >
                                <button
                                    onClick={toggleMute}
                                    className="player-control text-content-muted hover:text-content"
                                    aria-label={
                                        volume === 0
                                            ? ru.player.unmute
                                            : ru.player.mute
                                    }
                                >
                                    {isMuted || volume === 0 ? (
                                        <VolumeX className="w-[18px] h-[18px]" />
                                    ) : (
                                        <Volume2 className="w-[18px] h-[18px]" />
                                    )}
                                </button>

                                <div
                                    className={cn(
                                        "absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-1.5 py-3 bg-surface-hover border border-white/10 rounded-lg shadow-xl transition-all duration-200 overflow-hidden",
                                        showVolumePopup
                                            ? "opacity-100 scale-100 pointer-events-auto"
                                            : "opacity-0 scale-95 pointer-events-none",
                                    )}
                                >
                                    <div className="flex flex-col items-center gap-3 h-28">
                                        <div className="relative h-full w-3 flex items-center justify-center overflow-hidden">
                                            <input
                                                type="range"
                                                min="0"
                                                max="100"
                                                value={volume * 100}
                                                onChange={handleVolumeChange}
                                                aria-label={ru.player.volume}
                                                aria-valuemin={0}
                                                aria-valuemax={100}
                                                aria-valuenow={Math.round(
                                                    volume * 100,
                                                )}
                                                aria-valuetext={`${Math.round(volume * 100)} percent`}
                                                style={{
                                                    background: `linear-gradient(to right, var(--music-ink) ${volume * 100}%, var(--music-line-strong) ${volume * 100}%)`,
                                                }}
                                                className="absolute w-24 h-1 rounded-full appearance-none cursor-pointer -rotate-90 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-white/30"
                                            />
                                        </div>
                                        <span className="text-[10px] text-gray-400 tabular-nums mt-0.5">
                                            {Math.round(volume * 100)}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <button
                                onClick={() => {
                                    if (playerMode === "overlay") {
                                        returnToPreviousMode();
                                    } else {
                                        setPlayerMode("overlay");
                                    }
                                }}
                                className={cn(
                                    "player-control",
                                    hasMedia
                                        ? "text-content-muted hover:text-content"
                                        : "cursor-not-allowed text-content-disabled",
                                )}
                                disabled={!hasMedia}
                                aria-label={
                                    playerMode === "overlay"
                                        ? ru.player.close
                                        : ru.player.open
                                }
                                title={
                                    playerMode === "overlay"
                                        ? ru.player.close
                                        : ru.player.open
                                }
                            >
                                {playerMode === "overlay" ? (
                                    <ChevronDown className="w-[18px] h-[18px]" />
                                ) : (
                                    <ChevronUp className="w-[18px] h-[18px]" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </footer>
    );
}
