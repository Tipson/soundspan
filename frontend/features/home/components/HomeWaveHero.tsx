"use client";

import Link from "next/link";
import { useCallback, useMemo } from "react";
import { AudioWaveform, ChevronRight, Play } from "lucide-react";
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
    const { setVibeMode, setVibeQueueIds, setVibeSourceFeatures, setWaveMode } =
        useAudioState();
    const tracks = useMemo(
        () => balancedUniqueTracks(personalizedFeed?.shelves),
        [personalizedFeed?.shelves],
    );
    const queue = useMemo(() => tracks.map(toProviderPlaybackTrack), [tracks]);
    const canPlay = queue.length > 0 && !isLoading;

    const startWave = useCallback(() => {
        if (queue.length === 0) return;
        setWaveMode("for-you");
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
        setWaveMode,
    ]);

    const playLabel = isLoading
        ? "Tuning your Wave"
        : canPlay
          ? "Play My Wave"
          : "More signals needed";

    return (
        <section className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-surface-raised shadow-2xl shadow-black/25">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brand/20 via-ai/5 to-transparent"
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute -left-20 top-1/2 h-44 w-44 -translate-y-1/2 rounded-full border border-brand/10 sm:h-72 sm:w-72"
            />

            <div className="relative grid grid-cols-[minmax(0,1fr)_9.5rem] items-end gap-x-3 gap-y-4 px-5 py-6 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-center sm:gap-x-8 sm:gap-y-5 sm:px-8 sm:py-9 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-x-12 lg:px-10 lg:py-10">
                <div className="col-span-2 max-w-3xl sm:col-span-1 sm:col-start-1 sm:row-start-1">
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-brand-light">
                        Your personal station
                    </p>
                    <h1 className="mt-3 max-w-3xl text-3xl font-black leading-[0.98] tracking-[-0.045em] text-content sm:text-5xl lg:text-6xl">
                        Your music, already in motion.
                    </h1>
                    <p className="mt-4 max-w-2xl text-sm leading-6 text-content-secondary sm:text-lg sm:leading-7">
                        <span className="sm:hidden">
                            Familiar favorites, fresh finds, and music that
                            keeps playing.
                        </span>
                        <span className="hidden sm:inline">
                            My Wave blends familiar favorites with fresh finds
                            and keeps playing without making you build or manage
                            a queue.
                        </span>
                    </p>
                </div>

                <div className="col-start-1 row-start-2 min-w-0 text-sm text-content-body sm:flex sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-2">
                    <span className="flex min-h-11 items-center gap-2 rounded-2xl border border-white/8 bg-black/20 px-3 py-2 sm:inline-flex sm:rounded-full sm:px-4">
                        <AudioWaveform
                            className="h-4 w-4 shrink-0 text-brand-hover"
                            aria-hidden="true"
                        />
                        <span className="sm:hidden">
                            Tuned by your likes and listening
                        </span>
                        <span className="hidden sm:inline">
                            Likes, skips, and listening tune what comes next
                        </span>
                    </span>
                    <Link
                        href="/vibe"
                        className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-full px-2 py-2 font-semibold text-brand-light transition-colors duration-200 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:mt-0 sm:px-3"
                    >
                        Tune the flow
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                </div>

                <div className="relative col-start-2 row-start-2 mx-auto grid aspect-square w-full place-items-center sm:row-span-2 sm:row-start-1 sm:w-[min(36vw,18rem)] lg:w-[min(28vw,19rem)]">
                    <span
                        aria-hidden="true"
                        className="absolute inset-0 rounded-full border border-brand/15 bg-black/10"
                    />
                    <span
                        aria-hidden="true"
                        className="absolute inset-[12%] rounded-full border border-ai/25"
                    />
                    <span
                        aria-hidden="true"
                        className="absolute inset-[25%] rounded-full border border-brand-light/20 bg-brand/5"
                    />
                    <button
                        type="button"
                        onClick={startWave}
                        disabled={!canPlay}
                        aria-label="Play My Wave"
                        className="relative z-10 flex h-28 w-28 flex-col items-center justify-center gap-1 rounded-full bg-brand px-3 text-center text-xs font-black text-black shadow-2xl shadow-brand/25 transition duration-200 hover:scale-[1.03] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface-raised disabled:scale-100 disabled:bg-surface-highlight disabled:text-content-muted disabled:shadow-none motion-reduce:transition-none sm:h-36 sm:w-36 sm:gap-2 sm:px-5 sm:text-sm lg:h-40 lg:w-40"
                    >
                        <Play
                            className="h-6 w-6 fill-current sm:h-7 sm:w-7"
                            aria-hidden="true"
                        />
                        <span>{playLabel}</span>
                    </button>
                </div>
            </div>
        </section>
    );
}
