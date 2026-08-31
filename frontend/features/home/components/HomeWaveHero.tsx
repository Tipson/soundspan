"use client";

import Link from "next/link";
import { useCallback, useMemo } from "react";
import { AudioWaveform, ChevronRight, Play } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioState } from "@/lib/audio-state-context";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import type { PersonalizedHomeFeed, PersonalizedTrack } from "../types";
import { ru } from "@/lib/i18n/ru";

interface HomeWaveHeroProps {
    personalizedFeed: PersonalizedHomeFeed | null;
    isLoading: boolean;
}

function balancedUniqueTracks(
    shelves: PersonalizedHomeFeed["shelves"] | undefined,
): PersonalizedTrack[] {
    if (!shelves) return [];
    const sources = [
        shelves.quickPicks,
        shelves.discovery,
        shelves.listenAgain,
    ];
    const positions = sources.map(() => 0);
    const seen = new Set<string>();
    const result: PersonalizedTrack[] = [];
    let foundTrack = true;

    while (foundTrack) {
        foundTrack = false;
        sources.forEach((source, sourceIndex) => {
            while (positions[sourceIndex] < source.length) {
                const track = source[positions[sourceIndex]];
                positions[sourceIndex] += 1;
                const key = track.youtubeVideoId || track.id;
                if (seen.has(key)) continue;
                seen.add(key);
                result.push(track);
                foundTrack = true;
                break;
            }
        });
    }

    return result;
}

/** Compact personal-radio quick start for the first Home viewport. */
export function HomeWaveHero({
    personalizedFeed,
    isLoading,
}: HomeWaveHeroProps) {
    const { playTracks } = useAudioControls();
    const {
        setIsShuffle,
        setShuffleIndices,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
        setWaveMode,
    } = useAudioState();
    const tracks = useMemo(
        () => balancedUniqueTracks(personalizedFeed?.shelves),
        [personalizedFeed?.shelves],
    );
    const queue = useMemo(() => tracks.map(toProviderPlaybackTrack), [tracks]);
    const focusTrack = useMemo(
        () => tracks.find((track) => track.album.coverArt) ?? tracks[0] ?? null,
        [tracks],
    );
    const focusCoverUrl = focusTrack?.album.coverArt
        ? api.getCoverArtUrl(focusTrack.album.coverArt, 720)
        : null;
    const canPlay = queue.length > 0 && !isLoading;

    const startWave = useCallback(() => {
        if (queue.length === 0) return;
        setWaveMode("for-you");
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
        setWaveMode,
    ]);

    const playLabel = isLoading
        ? ru.vibe.tuning
        : canPlay
          ? ru.home.startWave
          : ru.home.moreSignals;

    return (
        <section
            data-home-wave-layout="editorial-wave"
            aria-labelledby="home-wave-title"
            className="group relative isolate min-h-[16.25rem] overflow-hidden rounded-[1.75rem] border border-white/[0.08] bg-surface-raised shadow-[0_28px_90px_rgba(0,0,0,0.26)] lg:overflow-visible lg:rounded-none lg:border-0 lg:bg-transparent lg:shadow-none"
        >
            <div
                data-wave-ambient
                aria-hidden="true"
                className="absolute inset-0 overflow-hidden lg:-bottom-[42rem] lg:-left-16 lg:-right-12 lg:-top-28 lg:-z-10"
            >
                {focusCoverUrl && (
                    <CachedImage
                        src={focusCoverUrl}
                        alt=""
                        fill
                        loading="eager"
                        sizes="(min-width: 1024px) 1100px, 100vw"
                        className="scale-125 object-cover opacity-65 blur-[48px] saturate-150 transition duration-700 group-hover:scale-[1.28] motion-reduce:transition-none"
                    />
                )}
                <span className="absolute inset-0 bg-[radial-gradient(circle_at_68%_42%,rgba(212,116,61,0.34),transparent_30%),radial-gradient(circle_at_88%_48%,rgba(122,42,163,0.38),transparent_34%)]" />
                <span className="absolute inset-0 bg-gradient-to-r from-surface via-surface/80 to-surface/20" />
                <span className="absolute inset-0 bg-gradient-to-t from-surface/75 via-transparent to-black/15" />
            </div>

            <div className="relative grid min-h-[16.25rem] items-center gap-7 px-5 py-4 sm:grid-cols-[12.5rem_minmax(0,1fr)] sm:px-7 lg:grid-cols-[13.75rem_minmax(0,1fr)] lg:gap-8 lg:px-0">
                <div
                    data-wave-focus-cover
                    className="relative mx-auto aspect-square w-36 overflow-hidden rounded-[1.35rem] border border-white/10 bg-surface-highlight shadow-[0_28px_64px_rgba(0,0,0,0.42)] sm:w-full"
                >
                    {focusCoverUrl ? (
                        <CachedImage
                            src={focusCoverUrl}
                            alt={focusTrack?.album.title ?? ""}
                            fill
                            loading="eager"
                            sizes="(min-width: 1024px) 220px, (min-width: 640px) 200px, 144px"
                            className="object-cover"
                        />
                    ) : (
                        <span className="absolute inset-0 grid place-items-center bg-white/[0.055]">
                            <AudioWaveform
                                className="h-12 w-12 text-brand-light"
                                aria-hidden="true"
                            />
                        </span>
                    )}
                    <span className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
                </div>

                <div className="relative z-20 min-w-0 text-center sm:text-left">
                    <p className="text-[0.68rem] font-bold uppercase tracking-[0.3em] text-content-secondary">
                        {ru.vibe.title}
                    </p>
                    <h1
                        id="home-wave-title"
                        className="mt-2 text-[clamp(2.5rem,4.4vw,3.5rem)] font-black leading-[0.98] tracking-[-0.055em] text-content"
                    >
                        {ru.vibe.title}
                    </h1>
                    <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-content-secondary sm:mx-0 sm:text-base">
                        {ru.home.waveSummary}
                    </p>

                    <div className="mt-5 flex flex-wrap items-center justify-center gap-3 sm:justify-start">
                        <button
                            type="button"
                            onClick={startWave}
                            disabled={!canPlay}
                            aria-label={ru.vibe.play}
                            className="inline-flex min-h-12 items-center gap-2 rounded-full bg-gradient-to-r from-warning to-brand px-6 py-3 text-sm font-black text-white shadow-[0_14px_34px_rgba(163,74,255,0.24)] transition duration-200 active:scale-[0.97] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface-raised disabled:scale-100 disabled:bg-surface-highlight disabled:text-content-muted disabled:shadow-none motion-reduce:transition-none"
                        >
                            <Play
                                className="h-5 w-5 fill-current"
                                aria-hidden="true"
                            />
                            <span>{playLabel}</span>
                        </button>
                        <Link
                            href="/vibe"
                            className="inline-flex min-h-12 items-center gap-2 rounded-full border border-white/10 bg-black/25 px-5 py-3 text-sm font-bold text-content-secondary backdrop-blur-md transition-colors duration-200 hover:border-white/20 hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            <AudioWaveform
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                            {ru.vibe.tune}
                            <ChevronRight
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                        </Link>
                    </div>
                </div>
            </div>
        </section>
    );
}
