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
    const coverTracks = useMemo(() => {
        const seen = new Set<string>();
        return tracks
            .filter((track) => {
                const cover = track.album.coverArt;
                if (!cover || seen.has(cover)) return false;
                seen.add(cover);
                return true;
            })
            .slice(0, 3);
    }, [tracks]);
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
          ? ru.vibe.play
          : ru.home.moreSignals;

    return (
        <section
            data-home-wave-layout="quick-start"
            aria-labelledby="home-wave-title"
            className="group relative isolate overflow-hidden rounded-2xl border border-white/8 bg-surface-raised/80 shadow-lg shadow-black/15"
        >
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-gradient-to-r from-brand/20 via-ai/[0.06] to-transparent opacity-80 transition-opacity duration-300 group-hover:opacity-100 motion-reduce:transition-none"
            />

            <div className="relative grid min-h-[8.75rem] items-center gap-4 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_11rem] sm:px-5 lg:grid-cols-[minmax(0,1fr)_13rem] lg:px-6">
                <div className="relative z-20 min-w-0">
                    <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-brand-light">
                        <AudioWaveform className="h-4 w-4" aria-hidden="true" />
                        {ru.home.endlessRadio}
                    </p>
                    <h2
                        id="home-wave-title"
                        className="mt-1 text-2xl font-black leading-tight tracking-[-0.035em] text-content sm:text-[1.75rem]"
                    >
                        {ru.vibe.title}
                    </h2>
                    <p className="mt-1 line-clamp-2 max-w-2xl text-sm leading-5 text-content-secondary">
                        {ru.home.waveSummary}
                    </p>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={startWave}
                            disabled={!canPlay}
                            aria-label={ru.vibe.play}
                            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-content px-5 py-2.5 text-sm font-black text-surface shadow-lg shadow-black/20 transition duration-200 active:scale-[0.97] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface-raised disabled:scale-100 disabled:bg-surface-highlight disabled:text-content-muted disabled:shadow-none motion-reduce:transition-none"
                        >
                            <Play
                                className="h-5 w-5 fill-current"
                                aria-hidden="true"
                            />
                            <span>{playLabel}</span>
                        </button>
                        <Link
                            href="/vibe"
                            className="inline-flex min-h-11 items-center gap-1 rounded-full border border-white/10 bg-black/20 px-4 py-2.5 text-sm font-bold text-content-secondary transition-colors duration-200 hover:border-white/20 hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            {ru.vibe.tune}
                            <ChevronRight
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                        </Link>
                    </div>
                </div>

                <div className="relative hidden h-24 w-44 sm:block lg:w-52">
                    {coverTracks.length > 0 ? (
                        coverTracks.map((track, index) => {
                            const positions = [
                                "left-0 top-2 -rotate-[7deg]",
                                "left-1/2 top-0 z-10 -translate-x-1/2",
                                "right-0 top-2 rotate-[7deg]",
                            ];
                            return (
                                <span
                                    key={track.album.coverArt}
                                    data-wave-cover
                                    aria-hidden="true"
                                    className={`absolute aspect-square h-20 overflow-hidden rounded-xl bg-surface-highlight shadow-xl shadow-black/45 transition-transform duration-300 group-hover:-translate-y-1 motion-reduce:transition-none lg:h-24 ${positions[index]}`}
                                >
                                    <CachedImage
                                        src={api.getCoverArtUrl(
                                            track.album.coverArt ?? "",
                                            360,
                                        )}
                                        alt=""
                                        fill
                                        sizes="96px"
                                        className="object-cover"
                                    />
                                    <span className="absolute inset-0 bg-gradient-to-t from-black/35 to-transparent" />
                                </span>
                            );
                        })
                    ) : (
                        <span
                            aria-hidden="true"
                            className="absolute left-1/2 top-1/2 grid h-20 w-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/20 text-brand-light"
                        >
                            <AudioWaveform className="h-10 w-10" />
                        </span>
                    )}
                </div>
            </div>
        </section>
    );
}
