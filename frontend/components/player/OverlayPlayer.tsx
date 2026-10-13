"use client";

import { useOverlayGestures } from "./hooks/useOverlayGestures";
import { useDismissibleLayer } from "@/hooks/useDismissibleLayer";
import { useOverlayPlayerAudio } from "./hooks/useOverlayPlayerAudio";
import { useMediaInfo } from "@/hooks/useMediaInfo";
import { resolvePlaybackQualityBadgeFromStreamSource } from "@/hooks/useStreamBitrate";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CachedImage } from "@/components/ui/CachedImage";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    RotateCcw,
    RotateCw,
    ChevronDown,
    Music as MusicIcon,
    Shuffle,
    Repeat,
    Repeat1,
    AudioWaveform,
    Radio,
    Loader2,
    RefreshCw,
} from "lucide-react";
import { formatTime, clampTime, formatTimeRemaining } from "@/utils/formatTime";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { toast } from "sonner";
import { SeekSlider } from "./SeekSlider";
import { useFeatures } from "@/lib/features-context";
import {
    canLoadTrackRadio,
    loadTrackRadio,
    UnsupportedTrackRadioError,
} from "@/lib/radio/loadTrackRadio";
import { requestRadioQueue } from "@/lib/radio/radioRequestIntent";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { SyncBadge } from "@/components/player/SyncBadge";
import { useListenTogether } from "@/lib/listen-together-context";
import {
    OVERLAY_ACTIVE_TAB_STORAGE_KEY,
    readMigratingStorageItem,
    writeMigratingStorageItem,
} from "@/lib/storage-migration";
import { CurrentTrackPreferenceButtons } from "./CurrentTrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { PlaybackReport } from "./PlaybackReport";
import { OverlayQueueTab } from "./overlay-tabs/OverlayQueueTab";
import { OverlayLyricsTab } from "./overlay-tabs/OverlayLyricsTab";
import { OverlayRelatedTab } from "./overlay-tabs/OverlayRelatedTab";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { supportsTrackPreferences } from "@/lib/trackRef";

import { pluralRu, ru } from "@/lib/i18n/ru";

const OVERLAY_ACTIVE_TAB_KEY = OVERLAY_ACTIVE_TAB_STORAGE_KEY;

/**
 * Renders the OverlayPlayer component.
 */
export function OverlayPlayer() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isShuffle,
        repeatMode,
        vibeMode,
        queue,
        currentIndex,
        isPlaying,
        isBuffering,
        canSeek,
        downloadProgress,
        audioError,
        clearAudioError,
        playbackDuration,
        currentTime,
        pause,
        resume,
        next,
        previous,
        returnToPreviousMode,
        seek,
        toggleShuffle,
        toggleRepeat,
        startVibeMode,
        stopVibeMode,
        playTrack,
        playQueueIndex,
        setUpcoming,
        removeFromQueue,
        clearQueue,
        skipForward,
        skipBackward,
    } = useOverlayPlayerAudio();

    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const shouldReduceMotion = useReducedMotion();
    const { isInGroup, isHost, syncSetTrack } = useListenTogether();

    // Swipe state for track skipping
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const [isVibeLoading, setIsVibeLoading] = useState(false);
    const [isRadioLoading, setIsRadioLoading] = useState(false);
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    useDismissibleLayer(
        isDrawerOpen && isMobileOrTablet,
        () => setIsDrawerOpen(false),
        20,
    );
    const [activeTab, setActiveTab] = useState<"queue" | "lyrics" | "related">(
        "queue",
    );
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();
    const { title, subtitle, coverUrl, artistLink, mediaLink } =
        useMediaInfo(768);
    const currentTrackQualityBadge = useMemo(
        () =>
            resolvePlaybackQualityBadgeFromStreamSource(
                currentTrack?.streamSource === "youtube"
                    ? "youtube"
                    : undefined,
            ),
        [currentTrack?.streamSource],
    );
    // Skip is queue-based: the unified queue can mix tracks and episodes.
    const canSkip = queue.length > 0;
    const {
        swipeOffset,
        overlayDragOffset,
        isOverlayDragActive,
        overlayHeaderHandlers,
        drawerDragOffset,
        isDrawerDragActive,
        drawerHandleHandlers,
        resetDrawerDrag,
        trackSwipeHandlers,
    } = useOverlayGestures({
        canSkip,
        onPrevious: previous,
        onNext: next,
        onCloseOverlay: returnToPreviousMode,
        onCloseDrawer: () => setIsDrawerOpen(false),
    });
    const isTrackMode = playbackType === "track";
    const isLongForm =
        playbackType === "podcast" || playbackType === "audiobook";
    const preferenceTrackId = isTrackMode ? currentTrack?.id : undefined;
    const hasUnsupportedTrackPreferences =
        currentTrack && !supportsTrackPreferences(currentTrack);
    const isDesktopOverlayLayout = canSkip && !isMobileOrTablet;
    // The lyrics tab mounts only while shown, so it owns its own fetch.
    const lyricsLookupTrack = useMemo(
        () =>
            playbackType === "track" && currentTrack?.id
                ? {
                      id: currentTrack.id,
                      artist: currentTrack.artist?.name,
                      title: currentTrack.displayTitle || currentTrack.title,
                      album: currentTrack.album?.title,
                      duration: currentTrack.duration,
                  }
                : null,
        [currentTrack, playbackType],
    );

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
    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast);

    const displayTime = (() => {
        let time = currentTime;

        if (time <= 0) {
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
    const currentMediaId =
        currentTrack?.id ||
        currentAudiobook?.id ||
        currentPodcast?.id ||
        "default";
    const artworkLayoutId = `mobile-player-artwork-${currentMediaId}`;
    const queueTracks = queue;

    const tabPanelHeightClass = "min-h-0 flex-1";

    const handlePlayPause = useCallback(() => {
        if (audioError) {
            clearAudioError();
            resume();
            return;
        }
        if (isBuffering && !isPlaying) return;
        if (isPlaying) {
            pause();
        } else {
            resume();
        }
    }, [audioError, clearAudioError, isBuffering, isPlaying, pause, resume]);

    useEffect(() => {
        const savedTab = readMigratingStorageItem(OVERLAY_ACTIVE_TAB_KEY);
        if (
            savedTab === "queue" ||
            savedTab === "lyrics" ||
            savedTab === "related"
        ) {
            setActiveTab(savedTab);
        }
    }, []);

    useEffect(() => {
        writeMigratingStorageItem(OVERLAY_ACTIVE_TAB_KEY, activeTab);
    }, [activeTab]);

    useEffect(() => {
        overlayRef.current?.focus();
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            const isEditable =
                !!target &&
                (target.isContentEditable ||
                    tag === "input" ||
                    tag === "textarea" ||
                    tag === "select");

            if (isEditable) return;

            if (event.code === "Space") {
                event.preventDefault();
                handlePlayPause();
                return;
            }

            if (canSkip && event.key === "ArrowLeft") {
                event.preventDefault();
                previous();
                return;
            }

            if (canSkip && event.key === "ArrowRight") {
                event.preventDefault();
                next();
                return;
            }

            if (!canSkip) return;

            const key = event.key.toLowerCase();
            if (key === "q") setActiveTab("queue");
            if (key === "l") setActiveTab("lyrics");
            if (key === "r") setActiveTab("related");
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [canSkip, handlePlayPause, next, previous, returnToPreviousMode]);

    useEffect(() => {
        if (!canSkip) {
            setIsDrawerOpen(false);
            return;
        }
        if (!isMobileOrTablet) {
            setIsDrawerOpen(true);
        }
    }, [
        canSkip,
        isMobileOrTablet,
        currentTrack?.id,
        currentAudiobook?.id,
        currentPodcast?.id,
    ]);

    useEffect(() => {
        if (isDrawerOpen) return;
        resetDrawerDrag();
    }, [isDrawerOpen, resetDrawerDrag]);

    const handleSeek = useCallback(
        (time: number) => {
            seek(time);
        },
        [seek],
    );

    const handlePlayFromQueue = useCallback(
        (index: number) => {
            if (isInGroup) {
                if (!isHost) {
                    toast.info(ru.player.hostOnly);
                    return;
                }
                syncSetTrack(index);
                return;
            }
            playQueueIndex(index);
        },
        [isInGroup, isHost, syncSetTrack, playQueueIndex],
    );

    const handleRemoveFromQueue = useCallback(
        (index: number) => {
            removeFromQueue(index);
        },
        [removeFromQueue],
    );

    const handleClearQueue = useCallback(() => {
        clearQueue();
        toast.success(ru.player.queueCleared);
    }, [clearQueue]);

    // Handle Vibe toggle
    const handleVibeToggle = async () => {
        if (!currentTrack?.id) return;

        if (vibeMode) {
            stopVibeMode();
            toast.success(ru.player.vibeOff);
            return;
        }

        setIsVibeLoading(true);
        try {
            const result = await startVibeMode();

            if (result.success && result.trackCount > 0) {
                toast.success(ru.player.vibeOn, {
                    description: `${result.trackCount} ${pluralRu(
                        result.trackCount,
                        [
                            "похожий трек добавлен в очередь",
                            "похожих трека добавлены в очередь",
                            "похожих треков добавлено в очередь",
                        ],
                    )}`,
                    icon: (
                        <AudioWaveform className="w-4 h-4 text-brand-hover" />
                    ),
                });
            } else {
                toast.error("Не удалось найти похожие треки");
            }
        } catch (error) {
            sharedFrontendLogger.error("Failed to start vibe match:", error);
            toast.error("Не удалось подобрать похожую музыку");
        } finally {
            setIsVibeLoading(false);
        }
    };

    const handleStartRadio = async () => {
        if (!currentTrack || !canLoadTrackRadio(currentTrack)) return;
        setIsRadioLoading(true);
        try {
            const filtered = await requestRadioQueue(() =>
                loadTrackRadio(currentTrack),
            );
            if (!filtered) return;
            if (filtered.length === 0) {
                toast.error("Недостаточно похожей музыки для радио");
                return;
            }
            setUpcoming(filtered, true, true, {
                radioOrigin: filtered[0]?.radioOrigin,
            });
            toast.success(
                `Радио ${currentTrack.title}: ${filtered.length} ${pluralRu(filtered.length, ["трек", "трека", "треков"])}`,
            );
        } catch (error) {
            if (error instanceof UnsupportedTrackRadioError) {
                toast.error(error.message);
                return;
            }
            toast.error("Не удалось включить радио исполнителя");
        } finally {
            setIsRadioLoading(false);
        }
    };

    const handleDrawerTabToggle = (tab: "queue" | "lyrics" | "related") => {
        if (!isMobileOrTablet) {
            setActiveTab(tab);
            return;
        }
        if (activeTab === tab) {
            setIsDrawerOpen((prev) => !prev);
            return;
        }
        setActiveTab(tab);
        setIsDrawerOpen(true);
    };

    const trackRadioAction =
        currentTrack && canLoadTrackRadio(currentTrack) ? (
            <button
                type="button"
                onClick={handleStartRadio}
                disabled={isRadioLoading}
                className="inline-flex h-[44px] w-[44px] items-center justify-center rounded-[10px] text-content-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 motion-reduce:transition-none"
                title={ru.player.startArtistRadio}
                aria-label={ru.player.startArtistRadio}
            >
                {isRadioLoading ? (
                    <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" />
                ) : (
                    <Radio className="h-6 w-6" />
                )}
            </button>
        ) : null;

    if (!hasMedia) return null;

    return (
        <motion.div
            ref={overlayRef}
            tabIndex={-1}
            data-player-surface="overlay"
            data-media-kind={playbackType ?? "unknown"}
            data-player-transition
            initial={
                shouldReduceMotion
                    ? { opacity: 1, y: 0 }
                    : { opacity: 0, y: 24 }
            }
            animate={{
                opacity: Math.max(0.55, 1 - overlayDragOffset / 360),
                y: overlayDragOffset,
            }}
            transition={
                isOverlayDragActive
                    ? { duration: 0 }
                    : {
                          duration: shouldReduceMotion ? 0 : 0.22,
                          ease: [0.22, 1, 0.36, 1],
                      }
            }
            className={cn(
                "overlay-player-stage fixed inset-x-0 z-[9999] flex flex-col overflow-hidden",
                isMobileOrTablet
                    ? "inset-y-0"
                    : "bottom-[calc(var(--app-player-height-desktop)+var(--safe-area-bottom)+12px)] top-[calc(var(--app-topbar-height-desktop)+var(--safe-area-top)+12px)]",
            )}
            onTouchStart={
                isMobileOrTablet ? trackSwipeHandlers.onTouchStart : undefined
            }
            onTouchMove={
                isMobileOrTablet ? trackSwipeHandlers.onTouchMove : undefined
            }
            onTouchEnd={
                isMobileOrTablet ? trackSwipeHandlers.onTouchEnd : undefined
            }
        >
            {coverUrl && (
                <div className="overlay-player-atmosphere" aria-hidden="true">
                    <CachedImage
                        src={coverUrl}
                        alt=""
                        fill
                        sizes="100vw"
                        className="object-cover"
                        priority
                        unoptimized
                    />
                </div>
            )}
            <div className="overlay-player-scrim" aria-hidden="true" />

            {/* Header */}
            <div
                className="overlay-player-chrome relative z-30 flex-shrink-0 px-4 pt-3 pb-2"
                style={{
                    paddingTop: "calc(12px + env(safe-area-inset-top))",
                    // Claim this drag before Chrome can start pull-to-refresh.
                    // The player content and queue keep native scrolling.
                    touchAction: isMobileOrTablet ? "none" : undefined,
                }}
                onTouchStart={
                    isMobileOrTablet
                        ? overlayHeaderHandlers.onTouchStart
                        : undefined
                }
                onTouchMove={
                    isMobileOrTablet
                        ? overlayHeaderHandlers.onTouchMove
                        : undefined
                }
                onTouchEnd={
                    isMobileOrTablet
                        ? overlayHeaderHandlers.onTouchEnd
                        : undefined
                }
            >
                <div className="flex items-center justify-between">
                    <button
                        type="button"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            returnToPreviousMode();
                        }}
                        onTouchStart={(e) => e.stopPropagation()}
                        className="flex h-[44px] w-[44px] items-center justify-center rounded-[10px] text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        aria-label="Свернуть плеер"
                        title="Свернуть плеер"
                    >
                        <ChevronDown className="h-6 w-6" aria-hidden="true" />
                    </button>
                    {/* Now Playing indicator */}
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-content-muted">
                            {ru.player.nowPlaying}
                        </span>
                        <SyncBadge compact />
                    </div>
                    <div
                        className="w-[44px]"
                        onTouchStart={(event) => event.stopPropagation()}
                    >
                        {playbackType === "track" && currentTrack && (
                            <TrackOverflowMenu
                                track={currentTrack}
                                showPlayNext={false}
                                showAddToQueue={false}
                                showMatchVibe={
                                    !featuresLoading && vibeEmbeddings
                                }
                                showStartRadio={false}
                                onMatchVibe={handleVibeToggle}
                                matchVibeLabel={
                                    vibeMode
                                        ? "Выключить похожую музыку"
                                        : ru.player.matchVibe
                                }
                                matchVibeDisabled={isVibeLoading}
                                triggerClassName="!h-[44px] !w-[44px] !p-0 !opacity-100"
                                menuClassName="max-h-[min(70dvh,560px)] overflow-y-auto"
                                extraItemsAfter={
                                    <PlaybackReport
                                        key={currentTrack.id}
                                        track={currentTrack}
                                    />
                                }
                            />
                        )}
                    </div>
                </div>
                {isMobileOrTablet && (
                    <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/25" />
                )}
            </div>

            {/* Main Content - Portrait vs Landscape */}
            <div
                className={cn(
                    "overlay-player-layout relative z-10 flex-1 min-h-0 px-4 pt-2",
                    isMobileOrTablet
                        ? "overflow-y-auto overscroll-y-contain pb-24"
                        : "overflow-hidden pb-6 landscape:px-8",
                )}
                style={isMobileOrTablet ? undefined : { paddingRight: "50%" }}
            >
                <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col items-center justify-center gap-4 landscape:gap-6">
                    {/* Left Rail: artwork + transport */}
                    <div
                        className={cn(
                            "w-full",
                            isMobileOrTablet
                                ? "max-w-[560px]"
                                : "max-w-[min(40vw,calc(100vh-20rem))]",
                        )}
                    >
                        <div
                            className={cn(
                                "mx-auto aspect-square w-full relative",
                                isMobileOrTablet
                                    ? "max-w-[clamp(7rem,calc(100dvh-25rem),82vw)]"
                                    : "max-w-[min(40vw,calc(100vh-20rem))]",
                            )}
                            style={{
                                transform: `translateX(${swipeOffset * 0.5}px)`,
                                opacity: 1 - Math.abs(swipeOffset) / 200,
                            }}
                        >
                            <div className="overlay-player-artwork-glow absolute inset-0 rounded-[14px] bg-brand/15 opacity-20 blur-2xl" />
                            <motion.div
                                layoutId={artworkLayoutId}
                                transition={
                                    shouldReduceMotion
                                        ? { duration: 0 }
                                        : {
                                              type: "spring",
                                              stiffness: 320,
                                              damping: 34,
                                          }
                                }
                                className="overlay-player-artwork relative h-full w-full overflow-hidden rounded-[14px] bg-surface-hover"
                            >
                                {coverUrl ? (
                                    <CachedImage
                                        key={coverUrl}
                                        src={coverUrl}
                                        alt={title}
                                        fill
                                        sizes="360px"
                                        className="object-cover"
                                        priority
                                        unoptimized
                                    />
                                ) : (
                                    <div className="flex h-full w-full items-center justify-center">
                                        <MusicIcon className="h-24 w-24 text-content-muted" />
                                    </div>
                                )}
                            </motion.div>

                            {canSkip &&
                                isMobileOrTablet &&
                                Math.abs(swipeOffset) > 20 && (
                                    <div
                                        className={cn(
                                            "absolute top-1/2 -translate-y-1/2 text-white/60",
                                            swipeOffset > 0
                                                ? "-left-8"
                                                : "-right-8",
                                        )}
                                    >
                                        {swipeOffset > 0 ? (
                                            <SkipBack className="h-6 w-6" />
                                        ) : (
                                            <SkipForward className="h-6 w-6" />
                                        )}
                                    </div>
                                )}
                        </div>

                        <div
                            className={cn(
                                "overlay-player-metadata mx-auto w-full",
                                isMobileOrTablet
                                    ? "mt-3 px-1 py-2"
                                    : "mt-5 max-w-[420px] p-4 landscape:max-w-none",
                            )}
                        >
                            <div
                                className={cn(
                                    "text-center",
                                    isMobileOrTablet ? "mb-4" : "mb-2",
                                )}
                            >
                                <div className="flex min-w-0 items-center justify-center gap-2">
                                    {mediaLink ? (
                                        <Link
                                            href={mediaLink}
                                            prefetch={false}
                                            onClick={returnToPreviousMode}
                                            className="min-w-0 hover:underline"
                                        >
                                            <h1 className="line-clamp-2 text-xl font-semibold leading-6 text-content">
                                                {title}
                                            </h1>
                                        </Link>
                                    ) : (
                                        <h1 className="line-clamp-2 text-xl font-semibold leading-6 text-content">
                                            {title}
                                        </h1>
                                    )}
                                </div>
                                {artistLink ? (
                                    <Link
                                        href={artistLink}
                                        prefetch={false}
                                        onClick={returnToPreviousMode}
                                        className="block hover:underline"
                                    >
                                        <p className="mt-1 truncate text-base text-content-muted">
                                            {subtitle}
                                        </p>
                                    </Link>
                                ) : (
                                    <p className="mt-1 truncate text-base text-content-muted">
                                        {subtitle}
                                    </p>
                                )}
                                {currentTrackQualityBadge?.variant ===
                                    "youtube" && (
                                    <div className="mt-1.5 flex justify-center">
                                        <YouTubeBadge />
                                    </div>
                                )}
                            </div>

                            {isMobileOrTablet && (
                                <>
                                    <div className="mb-4">
                                        <SeekSlider
                                            progress={progress}
                                            duration={duration}
                                            currentTime={displayTime}
                                            onSeek={handleSeek}
                                            canSeek={canSeek}
                                            hasMedia={hasMedia}
                                            downloadProgress={downloadProgress}
                                            variant="overlay"
                                            showHandle={false}
                                            className="mb-2"
                                        />
                                        <div className="flex justify-between text-xs font-medium tabular-nums text-content-muted">
                                            <span>
                                                {formatTime(displayTime)}
                                            </span>
                                            <span>
                                                {playbackType === "podcast" ||
                                                playbackType === "audiobook"
                                                    ? formatTimeRemaining(
                                                          Math.max(
                                                              0,
                                                              duration -
                                                                  displayTime,
                                                          ),
                                                      )
                                                    : formatTime(duration)}
                                            </span>
                                        </div>
                                    </div>

                                    {canSkip ? (
                                        <>
                                            <div className="overlay-player-transport mb-3 flex items-center justify-center gap-[8px] min-[375px]:gap-[16px]">
                                                {!isLongForm && (
                                                    <button
                                                        onClick={toggleShuffle}
                                                        className={cn(
                                                            "player-control transition-colors",
                                                            isShuffle
                                                                ? "text-brand-hover"
                                                                : "text-content-muted hover:text-white",
                                                        )}
                                                        title={
                                                            ru.player.shuffle
                                                        }
                                                        aria-label={
                                                            ru.player.shuffle
                                                        }
                                                        aria-pressed={isShuffle}
                                                        data-player-control="shuffle"
                                                        data-active={isShuffle}
                                                    >
                                                        <Shuffle className="h-5 w-5" />
                                                    </button>
                                                )}

                                                {isLongForm && (
                                                    <button
                                                        onClick={() =>
                                                            skipBackward(15)
                                                        }
                                                        className="player-control text-white/85 transition-colors hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                                                        disabled={!canSeek}
                                                        title={
                                                            ru.player.skipBack15
                                                        }
                                                        aria-label={
                                                            ru.player.skipBack15
                                                        }
                                                    >
                                                        <RotateCcw className="h-5 w-5" />
                                                    </button>
                                                )}

                                                <button
                                                    onClick={previous}
                                                    className="player-control text-white/85 transition-colors hover:text-white"
                                                    title={ru.player.previous}
                                                    aria-label={
                                                        ru.player.previous
                                                    }
                                                >
                                                    <SkipBack className="h-8 w-8" />
                                                </button>

                                                <button
                                                    onClick={handlePlayPause}
                                                    className={cn(
                                                        "overlay-player-primary player-control-primary flex h-[64px] w-[64px] flex-shrink-0 items-center justify-center rounded-[10px] transition-colors motion-reduce:transition-none",
                                                        audioError
                                                            ? "bg-error text-content hover:brightness-110"
                                                            : isBuffering &&
                                                                !isPlaying
                                                              ? "bg-white/80 text-black"
                                                              : "bg-content text-surface hover:bg-content/90",
                                                    )}
                                                    disabled={
                                                        isBuffering &&
                                                        !isPlaying
                                                    }
                                                    title={
                                                        audioError
                                                            ? ru.player.retry
                                                            : isBuffering &&
                                                                !isPlaying
                                                              ? ru.player
                                                                    .buffering
                                                              : isPlaying
                                                                ? ru.common
                                                                      .pause
                                                                : ru.common.play
                                                    }
                                                    aria-label={
                                                        audioError
                                                            ? ru.player.retry
                                                            : isPlaying
                                                              ? ru.common.pause
                                                              : ru.common.play
                                                    }
                                                >
                                                    {audioError ? (
                                                        <RefreshCw className="h-7 w-7" />
                                                    ) : isBuffering &&
                                                      !isPlaying ? (
                                                        <Loader2 className="h-7 w-7 animate-spin motion-reduce:animate-none" />
                                                    ) : isPlaying ? (
                                                        <Pause className="h-7 w-7" />
                                                    ) : (
                                                        <Play className="ml-1 h-7 w-7" />
                                                    )}
                                                </button>

                                                <button
                                                    onClick={next}
                                                    className="player-control text-white/85 transition-colors hover:text-white"
                                                    title={ru.player.next}
                                                    aria-label={ru.player.next}
                                                >
                                                    <SkipForward className="h-8 w-8" />
                                                </button>

                                                {isLongForm && (
                                                    <button
                                                        onClick={() =>
                                                            skipForward(15)
                                                        }
                                                        className="player-control text-white/85 transition-colors hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                                                        disabled={!canSeek}
                                                        title={
                                                            ru.player
                                                                .skipForward15
                                                        }
                                                        aria-label={
                                                            ru.player
                                                                .skipForward15
                                                        }
                                                    >
                                                        <RotateCw className="h-5 w-5" />
                                                    </button>
                                                )}

                                                {!isLongForm && (
                                                    <button
                                                        onClick={toggleRepeat}
                                                        className={cn(
                                                            "player-control transition-colors",
                                                            repeatMode !== "off"
                                                                ? "text-brand-hover"
                                                                : "text-content-muted hover:text-white",
                                                        )}
                                                        title={
                                                            repeatMode === "one"
                                                                ? ru.player
                                                                      .repeatOne
                                                                : repeatMode ===
                                                                    "all"
                                                                  ? ru.player
                                                                        .repeatAll
                                                                  : ru.player
                                                                        .repeatOff
                                                        }
                                                        aria-label={
                                                            repeatMode === "one"
                                                                ? ru.player
                                                                      .repeatOne
                                                                : repeatMode ===
                                                                    "all"
                                                                  ? ru.player
                                                                        .repeatAll
                                                                  : ru.player
                                                                        .repeatOff
                                                        }
                                                        aria-pressed={
                                                            repeatMode !== "off"
                                                        }
                                                        data-player-control="repeat"
                                                        data-active={
                                                            repeatMode !== "off"
                                                        }
                                                    >
                                                        {repeatMode ===
                                                        "one" ? (
                                                            <Repeat1 className="h-5 w-5" />
                                                        ) : (
                                                            <Repeat className="h-5 w-5" />
                                                        )}
                                                    </button>
                                                )}
                                            </div>
                                            {isTrackMode && (
                                                <div className="mb-3 flex items-center justify-center gap-3">
                                                    <CurrentTrackPreferenceButtons
                                                        trackId={
                                                            preferenceTrackId
                                                        }
                                                        mode="both"
                                                        buttonSizeClassName="h-[44px] w-[44px]"
                                                        iconSizeClassName="h-6 w-6"
                                                        betweenActions={
                                                            trackRadioAction
                                                        }
                                                        metadata={buildPreferenceMetadata(
                                                            currentTrack,
                                                        )}
                                                    />
                                                    {hasUnsupportedTrackPreferences &&
                                                        trackRadioAction}
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <div className="mb-3 flex items-center justify-center">
                                            <button
                                                onClick={handlePlayPause}
                                                className={cn(
                                                    "flex h-[64px] w-[64px] items-center justify-center rounded-[10px] transition-colors motion-reduce:transition-none",
                                                    audioError
                                                        ? "bg-error text-content hover:brightness-110"
                                                        : isBuffering &&
                                                            !isPlaying
                                                          ? "bg-white/80 text-black"
                                                          : "bg-content text-surface hover:bg-content/90",
                                                )}
                                                disabled={
                                                    isBuffering && !isPlaying
                                                }
                                                title={
                                                    isPlaying
                                                        ? ru.common.pause
                                                        : ru.common.play
                                                }
                                                aria-label={
                                                    isPlaying
                                                        ? ru.common.pause
                                                        : ru.common.play
                                                }
                                            >
                                                {audioError ? (
                                                    <RefreshCw className="h-7 w-7" />
                                                ) : isBuffering &&
                                                  !isPlaying ? (
                                                    <Loader2 className="h-7 w-7 animate-spin motion-reduce:animate-none" />
                                                ) : isPlaying ? (
                                                    <Pause className="h-7 w-7" />
                                                ) : (
                                                    <Play className="ml-1 h-7 w-7" />
                                                )}
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {canSkip && isMobileOrTablet && !isDrawerOpen && (
                <div
                    className="overlay-player-sheet absolute inset-x-0 bottom-0 z-20 border-t border-white/[0.12] px-4 pt-2 backdrop-blur-xl"
                    style={{
                        paddingBottom:
                            "calc(env(safe-area-inset-bottom) + 10px)",
                    }}
                >
                    <div className="mx-auto flex w-full max-w-sm items-center justify-center gap-[24px] text-sm">
                        <button
                            onClick={() => handleDrawerTabToggle("queue")}
                            className={cn(
                                "inline-flex min-h-11 min-w-11 items-center justify-center border-b px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
                                activeTab === "queue"
                                    ? "border-brand-hover text-brand-hover"
                                    : "border-transparent text-content-muted hover:text-white",
                            )}
                        >
                            {ru.player.upNext}
                        </button>
                        <button
                            onClick={() => handleDrawerTabToggle("lyrics")}
                            className={cn(
                                "inline-flex min-h-11 min-w-11 items-center justify-center border-b px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
                                activeTab === "lyrics"
                                    ? "border-brand-hover text-brand-hover"
                                    : "border-transparent text-content-muted hover:text-white",
                            )}
                        >
                            {ru.player.lyrics}
                        </button>
                        <button
                            onClick={() => handleDrawerTabToggle("related")}
                            className={cn(
                                "inline-flex min-h-11 min-w-11 items-center justify-center border-b px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
                                activeTab === "related"
                                    ? "border-brand-hover text-brand-hover"
                                    : "border-transparent text-content-muted hover:text-white",
                            )}
                        >
                            {ru.player.related}
                        </button>
                    </div>
                </div>
            )}

            {canSkip && (isMobileOrTablet || isDesktopOverlayLayout) && (
                <AnimatePresence>
                    {isDrawerOpen && (
                        <motion.div
                            key="overlay-drawer"
                            initial={
                                shouldReduceMotion
                                    ? { opacity: 1, y: 0 }
                                    : { opacity: 0, y: 28 }
                            }
                            animate={
                                isMobileOrTablet
                                    ? {
                                          opacity: Math.max(
                                              0.62,
                                              1 - drawerDragOffset / 360,
                                          ),
                                          y: drawerDragOffset,
                                      }
                                    : { opacity: 1, y: 0 }
                            }
                            exit={
                                shouldReduceMotion
                                    ? { opacity: 1, y: 0 }
                                    : {
                                          opacity: 0,
                                          y: isMobileOrTablet ? 92 : 28,
                                      }
                            }
                            transition={
                                isMobileOrTablet && isDrawerDragActive
                                    ? { duration: 0 }
                                    : { duration: shouldReduceMotion ? 0 : 0.2 }
                            }
                            className={cn(
                                "absolute",
                                isMobileOrTablet
                                    ? "overlay-player-sheet inset-0 z-40 border-t border-white/[0.12] backdrop-blur-xl"
                                    : "inset-y-0 right-0 z-20 w-[50%] min-w-[340px] py-24 pr-6",
                            )}
                        >
                            <div
                                className={cn(
                                    "flex h-full w-full flex-col",
                                    isMobileOrTablet
                                        ? "mx-auto max-w-none"
                                        : "",
                                )}
                            >
                                {isMobileOrTablet ? (
                                    <div
                                        className="border-b border-white/[0.08] px-3 pb-2"
                                        style={{
                                            paddingTop:
                                                "calc(10px + env(safe-area-inset-top))",
                                        }}
                                    >
                                        <div
                                            className="mb-1 flex items-center gap-3 px-1 py-1.5"
                                            role="button"
                                            tabIndex={0}
                                            onClick={() =>
                                                setIsDrawerOpen(false)
                                            }
                                            onKeyDown={(e) => {
                                                if (
                                                    e.key === "Enter" ||
                                                    e.key === " "
                                                ) {
                                                    e.preventDefault();
                                                    setIsDrawerOpen(false);
                                                }
                                            }}
                                        >
                                            <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded-md bg-surface-hover">
                                                {coverUrl ? (
                                                    <CachedImage
                                                        src={coverUrl}
                                                        alt={title}
                                                        fill
                                                        sizes="40px"
                                                        className="object-cover"
                                                        unoptimized
                                                    />
                                                ) : (
                                                    <div className="flex h-full w-full items-center justify-center">
                                                        <MusicIcon className="h-4 w-4 text-content-muted" />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium text-white">
                                                    {title}
                                                </p>
                                                <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                                                    <p className="min-w-0 truncate text-xs text-content-muted">
                                                        {subtitle}
                                                    </p>
                                                    {currentTrackQualityBadge?.variant ===
                                                        "youtube" && (
                                                        <YouTubeBadge />
                                                    )}
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handlePlayPause();
                                                }}
                                                className={cn(
                                                    "flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[10px] transition-colors motion-reduce:transition-none",
                                                    audioError
                                                        ? "bg-error text-content hover:brightness-110"
                                                        : "bg-white text-black hover:bg-white/90",
                                                )}
                                                aria-label={
                                                    audioError
                                                        ? ru.player.retry
                                                        : isPlaying
                                                          ? ru.common.pause
                                                          : ru.common.play
                                                }
                                                title={
                                                    audioError
                                                        ? ru.player.retry
                                                        : isPlaying
                                                          ? ru.common.pause
                                                          : ru.common.play
                                                }
                                            >
                                                {audioError ? (
                                                    <RefreshCw className="h-4 w-4" />
                                                ) : isBuffering &&
                                                  !isPlaying ? (
                                                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                                                ) : isPlaying ? (
                                                    <Pause className="h-4 w-4" />
                                                ) : (
                                                    <Play className="ml-0.5 h-4 w-4" />
                                                )}
                                            </button>
                                        </div>
                                        <div
                                            className="mb-2 flex h-12 w-full items-center justify-center"
                                            onTouchStart={
                                                drawerHandleHandlers.onTouchStart
                                            }
                                            onTouchMove={
                                                drawerHandleHandlers.onTouchMove
                                            }
                                            onTouchEnd={
                                                drawerHandleHandlers.onTouchEnd
                                            }
                                            style={{ touchAction: "none" }}
                                            aria-label={ru.player.swipeClose}
                                        >
                                            <div className="h-1 w-12 rounded-full bg-content-muted/50" />
                                        </div>
                                        <div className="mx-auto flex w-full max-w-xs items-center justify-center gap-[16px] text-sm">
                                            <button
                                                onClick={() =>
                                                    setActiveTab("queue")
                                                }
                                                className={cn(
                                                    "inline-flex min-h-11 min-w-11 items-center justify-center border-b px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
                                                    activeTab === "queue"
                                                        ? "border-brand-hover text-brand-hover"
                                                        : "border-transparent text-content-muted hover:text-white",
                                                )}
                                            >
                                                {ru.player.upNext}
                                            </button>
                                            <button
                                                onClick={() =>
                                                    setActiveTab("lyrics")
                                                }
                                                className={cn(
                                                    "inline-flex min-h-11 min-w-11 items-center justify-center border-b px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
                                                    activeTab === "lyrics"
                                                        ? "border-brand-hover text-brand-hover"
                                                        : "border-transparent text-content-muted hover:text-white",
                                                )}
                                            >
                                                {ru.player.lyrics}
                                            </button>
                                            <button
                                                onClick={() =>
                                                    setActiveTab("related")
                                                }
                                                className={cn(
                                                    "inline-flex min-h-11 min-w-11 items-center justify-center border-b px-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
                                                    activeTab === "related"
                                                        ? "border-brand-hover text-brand-hover"
                                                        : "border-transparent text-content-muted hover:text-white",
                                                )}
                                            >
                                                {ru.player.related}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-6 px-1 pb-3 text-sm">
                                        <button
                                            onClick={() =>
                                                setActiveTab("queue")
                                            }
                                            className={cn(
                                                "inline-flex min-h-11 min-w-11 items-center justify-center border-b px-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
                                                activeTab === "queue"
                                                    ? "border-brand-hover text-brand-hover"
                                                    : "border-transparent text-content-muted hover:text-white",
                                            )}
                                        >
                                            {ru.player.upNext}
                                        </button>
                                        <button
                                            onClick={() =>
                                                setActiveTab("lyrics")
                                            }
                                            className={cn(
                                                "inline-flex min-h-11 min-w-11 items-center justify-center border-b px-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
                                                activeTab === "lyrics"
                                                    ? "border-brand-hover text-brand-hover"
                                                    : "border-transparent text-content-muted hover:text-white",
                                            )}
                                        >
                                            {ru.player.lyrics}
                                        </button>
                                        <button
                                            onClick={() =>
                                                setActiveTab("related")
                                            }
                                            className={cn(
                                                "inline-flex min-h-11 min-w-11 items-center justify-center border-b px-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none",
                                                activeTab === "related"
                                                    ? "border-brand-hover text-brand-hover"
                                                    : "border-transparent text-content-muted hover:text-white",
                                            )}
                                        >
                                            {ru.player.related}
                                        </button>
                                    </div>
                                )}

                                <div
                                    className={cn(
                                        "min-h-0 flex-1 overflow-hidden",
                                        tabPanelHeightClass,
                                    )}
                                >
                                    <AnimatePresence
                                        initial={false}
                                        mode="wait"
                                    >
                                        {activeTab === "queue" && (
                                            <OverlayQueueTab
                                                key="queue"
                                                queueTracks={queueTracks}
                                                currentIndex={currentIndex}
                                                onPlayFromQueue={
                                                    handlePlayFromQueue
                                                }
                                                onRemoveFromQueue={
                                                    handleRemoveFromQueue
                                                }
                                                onClearQueue={handleClearQueue}
                                            />
                                        )}

                                        {activeTab === "lyrics" && (
                                            <OverlayLyricsTab
                                                key="lyrics"
                                                lookupTrack={lyricsLookupTrack}
                                                currentTime={displayTime}
                                                isPlaying={isPlaying}
                                                onSeek={handleSeek}
                                            />
                                        )}

                                        {activeTab === "related" && (
                                            <OverlayRelatedTab
                                                key="related"
                                                currentTrack={currentTrack}
                                                isTrackPlayback={
                                                    playbackType === "track"
                                                }
                                                playTrack={playTrack}
                                                onNavigate={
                                                    returnToPreviousMode
                                                }
                                            />
                                        )}
                                    </AnimatePresence>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            )}

            {/* Safe area padding at bottom */}
            <div style={{ height: "env(safe-area-inset-bottom)" }} />
        </motion.div>
    );
}
