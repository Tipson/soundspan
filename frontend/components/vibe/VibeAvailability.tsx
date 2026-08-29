"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
    Heart,
    History,
    ListMusic,
    Loader2,
    Play,
    RotateCcw,
    SkipForward,
    ThumbsDown,
} from "lucide-react";
import { PersonalizedTrackShelf } from "@/features/home/components/PersonalizedTrackShelf";
import {
    type PersonalizedHomeMode,
    usePersonalizedHomeFeed,
} from "@/features/home/hooks/usePersonalizedHomeFeed";
import type { PersonalizedTrack } from "@/features/home/types";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioState } from "@/lib/audio-state-context";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import { NowPlayingConnected } from "./NowPlayingConnected";

type WaveFeedMode = PersonalizedHomeMode;

interface WaveModeDefinition {
    id: WaveFeedMode;
    label: string;
    subtitle: string;
}

const WAVE_MODES: readonly WaveModeDefinition[] = [
    {
        id: "for-you",
        label: "For you",
        subtitle: "A balanced flow of favorites and fresh finds",
    },
    {
        id: "new",
        label: "New to me",
        subtitle: "Discovery picks outside your usual rotation",
    },
    {
        id: "familiar",
        label: "Familiar",
        subtitle: "Music you return to and quick picks you know",
    },
];

const WAVE_SIGNALS = [
    { label: "Likes", icon: Heart },
    { label: "Dislikes", icon: ThumbsDown },
    { label: "Skips", icon: SkipForward },
    { label: "Listening", icon: History },
    { label: "Playlists", icon: ListMusic },
] as const;

function uniqueTracks(tracks: readonly PersonalizedTrack[]) {
    const seen = new Set<string>();
    return tracks.filter((track) => {
        const key = track.youtubeVideoId || track.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function balancedUniqueTracks(
    shelves: readonly (readonly PersonalizedTrack[])[],
): PersonalizedTrack[] {
    const positions = shelves.map(() => 0);
    const seen = new Set<string>();
    const result: PersonalizedTrack[] = [];
    let addedTrack = true;

    while (addedTrack) {
        addedTrack = false;
        shelves.forEach((shelf, shelfIndex) => {
            while (positions[shelfIndex] < shelf.length) {
                const track = shelf[positions[shelfIndex]];
                positions[shelfIndex] += 1;
                const key = track.youtubeVideoId || track.id;
                if (seen.has(key)) continue;
                seen.add(key);
                result.push(track);
                addedTrack = true;
                break;
            }
        });
    }

    return result;
}

function selectWaveTracks(
    shelves:
        | {
              quickPicks: PersonalizedTrack[];
              discovery: PersonalizedTrack[];
              listenAgain: PersonalizedTrack[];
          }
        | undefined,
    mode: WaveFeedMode,
): PersonalizedTrack[] {
    if (!shelves) return [];
    if (mode === "new") return uniqueTracks(shelves.discovery);
    if (mode === "familiar") {
        return uniqueTracks(
            shelves.listenAgain.length > 0
                ? shelves.listenAgain
                : shelves.quickPicks,
        );
    }
    return balancedUniqueTracks([
        shelves.quickPicks,
        shelves.discovery,
        shelves.listenAgain,
    ]);
}

/** Online-first personal radio with explicit direction and feedback controls. */
export function VibeProviderFallback() {
    const [activeMode, setActiveMode] = useState<WaveFeedMode>("for-you");
    const { advanceQueue, playTracks } = useAudioControls();
    const {
        currentTrack,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
        setWaveMode,
    } = useAudioState();
    const { data, isLoading, isError, refetch } = usePersonalizedHomeFeed(
        12,
        true,
        activeMode,
    );
    const tracks = useMemo(
        () => selectWaveTracks(data?.shelves, activeMode),
        [activeMode, data?.shelves],
    );
    const queue = useMemo(() => tracks.map(toProviderPlaybackTrack), [tracks]);
    const activeModeDefinition =
        WAVE_MODES.find((mode) => mode.id === activeMode) ?? WAVE_MODES[0];
    const canPlay = queue.length > 0 && !isLoading;
    const startWave = useCallback(() => {
        if (queue.length === 0) return;
        setWaveMode(activeMode);
        playTracks(queue, 0, true);
        setVibeMode(true);
        setVibeSourceFeatures(null);
        setVibeQueueIds(queue.map((track) => track.id));
    }, [
        playTracks,
        queue,
        activeMode,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
        setWaveMode,
    ]);

    return (
        <main className="relative min-h-screen overflow-hidden bg-surface px-4 pb-28 pt-5 sm:px-6 sm:pt-7">
            <div className="mx-auto max-w-6xl space-y-5 sm:space-y-6">
                <section className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-surface-raised px-5 py-7 shadow-2xl shadow-black/30 sm:px-8 sm:py-9">
                    <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-12">
                        <div className="max-w-2xl">
                            <p className="text-xs font-bold uppercase tracking-[0.22em] text-brand-light">
                                Your personal radio
                            </p>
                            <h1 className="mt-3 text-4xl font-black tracking-[-0.045em] text-white sm:text-5xl">
                                My Wave
                            </h1>
                            <p className="mt-4 max-w-xl text-base leading-7 text-content-secondary">
                                Your likes, dislikes, listening history, and
                                playlists steer what comes next. Every choice
                                reshapes the flow while you listen.
                            </p>

                            <ul
                                aria-label="Signals that tune My Wave"
                                className="mt-6 grid max-w-xl grid-cols-2 gap-2 sm:grid-cols-5"
                            >
                                {WAVE_SIGNALS.map((signal) => {
                                    const SignalIcon = signal.icon;
                                    return (
                                        <li
                                            key={signal.label}
                                            className="flex items-center gap-2 rounded-full border border-white/8 bg-black/25 px-3 py-2 text-xs font-semibold text-content-body"
                                        >
                                            <SignalIcon
                                                className="h-3.5 w-3.5 shrink-0 text-brand-hover"
                                                aria-hidden="true"
                                            />
                                            {signal.label}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>

                        <div className="relative mx-auto grid aspect-square w-[min(78vw,19rem)] place-items-center lg:mx-0">
                            <span
                                aria-hidden="true"
                                className="absolute inset-0 rounded-full border border-brand/15"
                            />
                            <span
                                aria-hidden="true"
                                className="absolute inset-[12%] rounded-full border border-ai/30 shadow-2xl shadow-ai/20 motion-safe:animate-pulse"
                            />
                            <span
                                aria-hidden="true"
                                className="absolute inset-[25%] rounded-full border border-cyan-300/25"
                            />
                            <button
                                type="button"
                                onClick={startWave}
                                disabled={!canPlay}
                                className="relative z-10 flex h-32 w-32 flex-col items-center justify-center gap-2 rounded-full bg-brand px-4 text-center text-sm font-black text-black shadow-2xl shadow-brand/25 transition duration-200 hover:scale-[1.03] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface-raised disabled:scale-100 disabled:bg-surface-highlight disabled:text-content-muted disabled:shadow-none motion-reduce:transition-none sm:h-36 sm:w-36"
                                aria-label="Play My Wave"
                            >
                                <Play
                                    className="h-7 w-7 fill-current"
                                    aria-hidden="true"
                                />
                                <span>Play My Wave</span>
                            </button>
                        </div>
                    </div>
                </section>

                <section
                    aria-labelledby="wave-mode-title"
                    className="rounded-2xl border border-white/8 bg-surface-sunken p-3 sm:p-4"
                >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="px-1">
                            <h2
                                id="wave-mode-title"
                                className="text-sm font-bold text-white"
                            >
                                Tune the flow
                            </h2>
                            <p className="mt-0.5 text-xs text-content-muted">
                                Choose a direction, then start or restart your
                                Wave.
                            </p>
                        </div>
                        <div
                            className="grid grid-cols-3 gap-1 rounded-xl bg-black/35 p-1"
                            aria-label="My Wave modes"
                        >
                            {WAVE_MODES.map((mode) => {
                                const isActive = mode.id === activeMode;
                                return (
                                    <button
                                        key={mode.id}
                                        type="button"
                                        onClick={() => {
                                            setActiveMode(mode.id);
                                            setWaveMode(mode.id);
                                        }}
                                        aria-pressed={isActive}
                                        aria-controls="wave-track-shelf"
                                        className={`min-h-11 rounded-lg px-3 py-2 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:text-sm ${
                                            isActive
                                                ? "bg-brand text-black shadow-md shadow-brand/15"
                                                : "text-content-secondary hover:bg-white/7 hover:text-white"
                                        }`}
                                    >
                                        {mode.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </section>

                {currentTrack && (
                    <section
                        aria-labelledby="wave-feedback-title"
                        className="flex flex-col gap-4 rounded-2xl border border-brand/15 bg-brand/[0.055] p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
                    >
                        <div className="max-w-md">
                            <h2
                                id="wave-feedback-title"
                                className="text-sm font-bold text-white"
                            >
                                Shape the next tracks
                            </h2>
                            <p className="mt-1 text-xs leading-5 text-content-muted">
                                Like keeps this direction in your Wave. Dislike
                                skips this track now and prevents the same track
                                from returning in future picks.
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                            <NowPlayingConnected
                                track={currentTrack}
                                onMapPresent={false}
                                moodColor={null}
                                onFlyTo={() => undefined}
                            />
                            <button
                                type="button"
                                onClick={() => advanceQueue("manual")}
                                aria-label="Skip current track"
                                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/10 bg-surface-raised px-4 py-2 text-sm font-semibold text-content-body transition-colors hover:border-brand/35 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                            >
                                <SkipForward
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                />
                                Skip
                            </button>
                        </div>
                    </section>
                )}

                <div id="wave-track-shelf" aria-live="polite">
                    {isLoading ? (
                        <div
                            className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-2xl border border-white/8 bg-surface-raised"
                            aria-label="Tuning My Wave"
                        >
                            <Loader2 className="h-6 w-6 animate-spin text-brand-hover motion-reduce:animate-none" />
                            <p className="text-sm text-content-muted">
                                Tuning your next tracks…
                            </p>
                        </div>
                    ) : tracks.length > 0 ? (
                        <PersonalizedTrackShelf
                            title={activeModeDefinition.label}
                            subtitle={activeModeDefinition.subtitle}
                            tracks={tracks}
                        />
                    ) : (
                        <section className="rounded-2xl border border-white/8 bg-surface-raised p-6 sm:p-8">
                            <h2 className="text-lg font-bold text-white">
                                {isError
                                    ? "Your Wave is taking a moment"
                                    : activeMode === "new"
                                      ? "No discoveries queued yet"
                                      : activeMode === "familiar"
                                        ? "Nothing familiar yet"
                                        : "Start shaping your Wave"}
                            </h2>
                            <p className="mt-2 max-w-xl text-sm leading-6 text-content-muted">
                                {isError
                                    ? "Recommendations could not load. Check your connection and try again."
                                    : "Play a few songs, use like and dislike, or add a playlist. Your next Wave will have more to work with."}
                            </p>
                            {isError && (
                                <button
                                    type="button"
                                    onClick={() => void refetch()}
                                    aria-label="Retry My Wave recommendations"
                                    className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-brand/35 px-4 py-2 text-sm font-semibold text-brand-light transition-colors hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                >
                                    <RotateCcw
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                    Retry
                                </button>
                            )}
                        </section>
                    )}
                </div>

                <nav
                    className="flex flex-wrap gap-2 pt-1"
                    aria-label="Music shortcuts"
                >
                    <Link
                        href="/"
                        className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/10 bg-surface-raised px-5 py-2 text-sm font-semibold text-content-body transition hover:border-brand/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    >
                        Home
                    </Link>
                    <Link
                        href="/search"
                        className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/10 bg-surface-raised px-5 py-2 text-sm font-semibold text-content-body transition hover:border-brand/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    >
                        Search music
                    </Link>
                </nav>
            </div>
        </main>
    );
}
