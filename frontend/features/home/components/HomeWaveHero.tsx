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
    const { setVibeMode, setVibeQueueIds, setVibeSourceFeatures, setWaveMode } =
        useAudioState();
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
        <section
            data-home-wave-layout="immersive"
            aria-labelledby="home-wave-title"
            className="relative isolate overflow-hidden rounded-[1.75rem] border border-white/10 bg-surface-raised shadow-2xl shadow-black/25 sm:rounded-[2rem]"
        >
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brand/30 via-ai/10 to-transparent"
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-24 -top-36 h-[32rem] w-[32rem] rounded-full bg-info/10 blur-3xl"
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 left-0 h-2/3 w-2/3 bg-gradient-to-tr from-black/35 to-transparent"
            />

            <div className="relative grid gap-3 px-5 pb-5 pt-7 sm:px-8 sm:pb-7 sm:pt-9 lg:min-h-[25rem] lg:grid-cols-[minmax(0,0.95fr)_minmax(21rem,0.75fr)] lg:items-center lg:gap-10 lg:px-10 lg:py-9 xl:px-12">
                <div className="relative z-20 max-w-3xl">
                    <p className="text-xs font-black uppercase tracking-[0.22em] text-brand-light">
                        My Wave
                    </p>
                    <h1
                        id="home-wave-title"
                        className="mt-3 max-w-3xl text-[2.35rem] font-black leading-[0.92] tracking-[-0.06em] text-content sm:text-5xl lg:text-6xl xl:text-7xl"
                    >
                        Your music.
                        <span className="block text-content-secondary">
                            One endless flow.
                        </span>
                    </h1>
                    <p className="mt-4 max-w-xl text-sm leading-6 text-content-secondary sm:text-base sm:leading-7">
                        Favorites, forgotten tracks, and new discoveries keep
                        moving with you. Like, dislike, or skip — the next song
                        adapts.
                    </p>

                    <div className="mt-6 flex flex-wrap items-center gap-2.5 sm:mt-7">
                        <button
                            type="button"
                            onClick={startWave}
                            disabled={!canPlay}
                            aria-label="Play My Wave"
                            className="inline-flex min-h-12 items-center gap-2 rounded-full bg-content px-5 py-3 text-sm font-black text-surface shadow-xl shadow-black/25 transition duration-200 hover:scale-[1.02] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface-raised disabled:scale-100 disabled:bg-surface-highlight disabled:text-content-muted disabled:shadow-none motion-reduce:transition-none sm:px-6 sm:text-base"
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

                    <p className="mt-4 flex items-center gap-2 text-xs leading-5 text-content-muted sm:text-sm">
                        <AudioWaveform
                            className="h-4 w-4 shrink-0 text-brand-light"
                            aria-hidden="true"
                        />
                        Likes, skips, and listening tune what comes next.
                    </p>
                </div>

                <div className="relative mx-auto h-[15.5rem] w-full max-w-[25rem] lg:h-[21rem] lg:max-w-none">
                    <span
                        aria-hidden="true"
                        className="absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-brand/10 blur-sm lg:h-64 lg:w-64"
                    />
                    {coverTracks.length > 0 ? (
                        coverTracks.map((track, index) => {
                            const positions = [
                                "left-[3%] top-[18%] -rotate-[11deg]",
                                "left-1/2 top-[3%] z-10 -translate-x-1/2",
                                "right-[3%] top-[18%] rotate-[11deg]",
                            ];
                            return (
                                <span
                                    key={track.album.coverArt}
                                    data-wave-cover
                                    aria-hidden="true"
                                    className={`absolute aspect-square w-[43%] max-w-[12.5rem] overflow-hidden rounded-[1.25rem] border border-white/15 bg-surface-highlight shadow-2xl shadow-black/50 ${positions[index]}`}
                                >
                                    <CachedImage
                                        src={api.getCoverArtUrl(
                                            track.album.coverArt ?? "",
                                            360,
                                        )}
                                        alt=""
                                        fill
                                        sizes="(max-width: 1024px) 43vw, 200px"
                                        className="object-cover"
                                    />
                                    <span className="absolute inset-0 bg-gradient-to-t from-black/35 to-transparent" />
                                </span>
                            );
                        })
                    ) : (
                        <span
                            aria-hidden="true"
                            className="absolute left-1/2 top-1/2 grid h-40 w-40 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/10 bg-black/20 text-brand-light lg:h-52 lg:w-52"
                        >
                            <AudioWaveform className="h-14 w-14" />
                        </span>
                    )}
                    <span className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-black/70 px-3 py-2 text-xs font-bold text-content shadow-xl backdrop-blur-md lg:bottom-4">
                        <span className="h-2 w-2 rounded-full bg-brand-light shadow-[0_0_16px_currentColor]" />
                        Tuned to this account
                    </span>
                </div>
            </div>
        </section>
    );
}
