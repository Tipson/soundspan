"use client";

import Link from "next/link";
import { useCallback, useMemo } from "react";
import { AudioWaveform, ChevronRight, Pause, Play } from "lucide-react";
import { usePlaybackStatus } from "@/lib/audio-playback-context";
import { CachedImage } from "@/components/ui/CachedImage";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioState } from "@/lib/audio-state-context";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import type { PersonalizedHomeFeed } from "../types";
import { usePersonalizedHomeFeed } from "../hooks/usePersonalizedHomeFeed";
import { selectWaveTracks } from "../selectWaveTracks";
import { ru } from "@/lib/i18n/ru";
import { getRecommendationSessionId } from "@/lib/recommendationSession";
import { useRecommendationImpressions } from "../hooks/useRecommendationImpressions";
import { recommendationTrackKey } from "../recommendationIdentity";

interface HomeWaveHeroProps {
    personalizedFeed: PersonalizedHomeFeed | null;
    isLoading: boolean;
}

/** Compact personal-radio quick start for the first Home viewport. */
export function HomeWaveHero({
    personalizedFeed,
    isLoading: isHomeLoading,
}: HomeWaveHeroProps) {
    const { playTracks, pause, play } = useAudioControls();
    const { isPlaying } = usePlaybackStatus();
    const {
        vibeMode,
        currentTrack,
        waveMode,
        waveMood,
        waveLanguage = "any",
        setIsShuffle,
        setShuffleIndices,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
    } = useAudioState();
    const { data: waveFeed, isLoading: isWaveLoading } =
        usePersonalizedHomeFeed(
            12,
            true,
            waveMode,
            waveMood,
            "wave",
            waveLanguage,
        );
    const isLoading = isHomeLoading || isWaveLoading;
    const tracks = useMemo(
        () => selectWaveTracks(waveFeed?.shelves, waveMode),
        [waveFeed?.shelves, waveMode],
    );
    const generationId = waveFeed?.generationId;
    const queue = useMemo(
        () =>
            tracks.map((track) =>
                toProviderPlaybackTrack(track, {
                    generationId,
                    sessionId: getRecommendationSessionId(),
                }),
            ),
        [generationId, tracks],
    );
    const focusTrack = useMemo(
        () =>
            tracks.find((track) => track.album.coverArt) ??
            tracks[0] ??
            personalizedFeed?.shelves.discovery[0] ??
            null,
        [tracks, personalizedFeed?.shelves.discovery],
    );
    const visibleTracks = useMemo(
        () => (waveFeed && focusTrack ? [focusTrack] : []),
        [waveFeed, focusTrack],
    );
    const impressionRef = useRecommendationImpressions(
        generationId,
        visibleTracks,
    );
    const focusCoverUrl = focusTrack?.album.coverArt
        ? api.getCoverArtUrl(focusTrack.album.coverArt, 720)
        : null;
    const canPlay = queue.length > 0 && !isLoading;

    const startWave = useCallback(() => {
        if (queue.length === 0) return;
        setIsShuffle(false);
        setShuffleIndices([]);
        playTracks(queue, 0, true);
        setVibeMode(true);
        setVibeSourceFeatures(null);
        setVibeQueueIds(queue.map((track) => track.id));
    }, [
        playTracks,
        queue,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
        setIsShuffle,
        setShuffleIndices,
    ]);

    const hasActiveWave = vibeMode && currentTrack !== null;
    const isWavePlaying = hasActiveWave && isPlaying;
    const toggleWave = useCallback(() => {
        if (!hasActiveWave) startWave();
        else if (isPlaying) pause();
        else play();
    }, [hasActiveWave, isPlaying, pause, play, startWave]);
    const playLabel = hasActiveWave
        ? isPlaying
            ? ru.common.pause
            : "Продолжить"
        : isLoading
          ? ru.vibe.tuning
          : canPlay
            ? ru.home.startWave
            : waveLanguage !== "any"
              ? waveFeed?.languageStatus?.pending
                  ? "Уточняем язык треков"
                  : "Нет подходящих треков"
              : ru.home.moreSignals;

    return (
        <section
            ref={impressionRef}
            data-recommendation-track-key={
                focusTrack ? recommendationTrackKey(focusTrack) : undefined
            }
            data-home-wave-layout="editorial-wave"
            aria-labelledby="home-wave-title"
            className="group relative isolate overflow-hidden rounded-[14px] border border-white/[0.08] bg-surface-raised"
        >
            <div
                data-wave-ambient
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-hidden"
            >
                {focusCoverUrl && (
                    <CachedImage
                        src={focusCoverUrl}
                        alt=""
                        fill
                        priority
                        sizes="(min-width: 1024px) 1100px, 100vw"
                        className="scale-125 object-cover opacity-20 blur-[48px] transition-opacity duration-700 motion-reduce:transition-none"
                    />
                )}
                <span className="absolute inset-0 bg-gradient-to-r from-surface-raised/85 to-surface-raised/45" />
            </div>

            <div className="relative grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-4 gap-y-4 p-4 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-x-6 sm:p-6">
                <div
                    data-wave-focus-cover
                    className="relative aspect-square w-full overflow-hidden rounded-[14px] bg-surface-highlight sm:row-span-2"
                >
                    {focusCoverUrl ? (
                        <CachedImage
                            src={focusCoverUrl}
                            alt={focusTrack?.album.title ?? ""}
                            fill
                            priority
                            sizes="(min-width: 640px) 120px, 64px"
                            className="object-cover"
                        />
                    ) : (
                        <span className="absolute inset-0 grid place-items-center bg-white/[0.055]">
                            <AudioWaveform
                                className="h-8 w-8 text-brand-light"
                                aria-hidden="true"
                            />
                        </span>
                    )}
                    <span className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
                </div>

                <div className="relative z-20 min-w-0 text-left">
                    <h1
                        id="home-wave-title"
                        className="text-2xl font-bold leading-tight tracking-[-0.035em] text-content sm:text-3xl"
                    >
                        {ru.vibe.title}
                    </h1>
                    <p className="mt-1 max-w-xl text-xs leading-5 text-content-secondary sm:text-sm">
                        {ru.home.waveSummary}
                    </p>
                </div>

                <div className="relative z-20 col-span-2 flex min-w-0 items-center gap-2 sm:col-span-1 sm:col-start-2 sm:justify-start">
                    <button
                        type="button"
                        onClick={toggleWave}
                        disabled={!hasActiveWave && !canPlay}
                        aria-label={
                            isWavePlaying ? ru.vibe.pause : ru.vibe.play
                        }
                        aria-pressed={isWavePlaying}
                        data-home-wave-state={
                            hasActiveWave
                                ? isPlaying
                                    ? "playing"
                                    : "paused"
                                : isLoading
                                  ? "loading"
                                  : canPlay
                                    ? "ready"
                                    : "needs-signals"
                        }
                        className="inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-[10px] bg-brand px-3 py-2 text-sm font-bold text-black transition-colors duration-200 hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised disabled:border disabled:border-white/10 disabled:bg-none disabled:bg-white/[0.08] disabled:text-content-secondary sm:flex-none sm:px-5 motion-reduce:transition-none"
                    >
                        {isWavePlaying ? (
                            <Pause
                                className="h-5 w-5 fill-current"
                                aria-hidden="true"
                            />
                        ) : (
                            <Play
                                className="h-5 w-5 fill-current"
                                aria-hidden="true"
                            />
                        )}
                        <span>{playLabel}</span>
                    </button>
                    <Link
                        href="/vibe"
                        className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[10px] px-3 py-2 text-sm font-semibold text-content-secondary transition-colors duration-200 hover:bg-white/[0.06] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    >
                        {ru.vibe.tune}
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                </div>
            </div>
        </section>
    );
}
