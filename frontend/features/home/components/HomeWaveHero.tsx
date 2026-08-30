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

/** Personal-radio hero with an immediate, playable My Wave action. */
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
        ? "Tuning your Wave"
        : canPlay
          ? "Play My Wave"
          : "More signals needed";

    return (
        <section
            data-home-wave-layout="compact"
            aria-labelledby="home-wave-title"
            className="relative isolate overflow-hidden rounded-[1.5rem] bg-surface-raised shadow-2xl shadow-black/25 sm:rounded-[1.75rem]"
        >
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brand/25 via-ai/[0.07] to-transparent"
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-16 -top-28 h-80 w-80 rounded-full bg-info/10 blur-3xl"
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 left-0 h-2/3 w-2/3 bg-gradient-to-tr from-black/30 to-transparent"
            />

            <div className="relative grid gap-5 px-5 py-6 sm:px-7 sm:py-7 lg:min-h-[17rem] lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.55fr)] lg:items-center lg:gap-8 lg:px-9 lg:py-8">
                <div className="relative z-20 max-w-3xl">
                    <p className="text-xs font-black uppercase tracking-[0.2em] text-brand-light">
                        My Wave
                    </p>
                    <h1
                        id="home-wave-title"
                        className="mt-2 max-w-3xl text-[2rem] font-black leading-[0.98] tracking-[-0.055em] text-content sm:text-4xl lg:text-5xl"
                    >
                        Press play.
                        <span className="block text-content-secondary">
                            It keeps going.
                        </span>
                    </h1>
                    <p className="mt-3 max-w-xl text-sm leading-6 text-content-secondary sm:text-[0.9375rem]">
                        Familiar favorites and new discoveries in one continuous
                        queue. Every like, dislike, and skip tunes what follows.
                    </p>

                    <div className="mt-5 flex flex-wrap items-center gap-2.5">
                        <button
                            type="button"
                            onClick={startWave}
                            disabled={!canPlay}
                            aria-label="Play My Wave"
                            className="inline-flex min-h-12 items-center gap-2 rounded-full bg-content px-5 py-3 text-sm font-black text-surface shadow-xl shadow-black/25 transition duration-200 active:scale-[0.98] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface-raised disabled:scale-100 disabled:bg-surface-highlight disabled:text-content-muted disabled:shadow-none motion-reduce:transition-none sm:px-6 sm:text-base"
                        >
                            <Play
                                className="h-5 w-5 fill-current"
                                aria-hidden="true"
                            />
                            <span>{playLabel}</span>
                        </button>
                        <Link
                            href="/vibe"
                            className="inline-flex min-h-12 items-center gap-1 rounded-full border border-white/10 bg-black/20 px-4 py-3 text-sm font-bold text-content-secondary transition-colors duration-200 hover:border-white/20 hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            Tune the flow
                            <ChevronRight
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                        </Link>
                    </div>

                    <p className="mt-3 flex items-center gap-2 text-xs leading-5 text-content-muted">
                        <AudioWaveform
                            className="h-4 w-4 shrink-0 text-brand-light"
                            aria-hidden="true"
                        />
                        Tuned to this account, never a fixed playlist.
                    </p>
                </div>

                <div className="relative mx-auto h-[8.5rem] w-full max-w-[22rem] lg:h-[14rem] lg:max-w-none">
                    <span
                        aria-hidden="true"
                        className="absolute left-1/2 top-1/2 h-28 w-28 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-brand/10 blur-sm lg:h-44 lg:w-44"
                    />
                    {coverTracks.length > 0 ? (
                        coverTracks.map((track, index) => {
                            const positions = [
                                "left-[7%] top-[14%] -rotate-[9deg]",
                                "left-1/2 top-[3%] z-10 -translate-x-1/2",
                                "right-[7%] top-[14%] rotate-[9deg]",
                            ];
                            return (
                                <span
                                    key={track.album.coverArt}
                                    data-wave-cover
                                    aria-hidden="true"
                                    className={`absolute aspect-square w-[37%] max-w-[9.5rem] overflow-hidden rounded-2xl border border-white/15 bg-surface-highlight shadow-2xl shadow-black/50 ${positions[index]}`}
                                >
                                    <CachedImage
                                        src={api.getCoverArtUrl(
                                            track.album.coverArt ?? "",
                                            360,
                                        )}
                                        alt=""
                                        fill
                                        sizes="(max-width: 1024px) 37vw, 152px"
                                        className="object-cover"
                                    />
                                    <span className="absolute inset-0 bg-gradient-to-t from-black/35 to-transparent" />
                                </span>
                            );
                        })
                    ) : (
                        <span
                            aria-hidden="true"
                            className="absolute left-1/2 top-1/2 grid h-24 w-24 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/10 bg-black/20 text-brand-light lg:h-36 lg:w-36"
                        >
                            <AudioWaveform className="h-14 w-14" />
                        </span>
                    )}
                </div>
            </div>
        </section>
    );
}
