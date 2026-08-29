"use client";

import { useCallback, useMemo, useState } from "react";
import { Loader2, Play, RotateCcw, SkipForward } from "lucide-react";
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
        <main className="relative min-h-full overflow-hidden bg-surface px-4 pb-4 pt-5 sm:px-6 sm:pb-8 sm:pt-7">
            <div className="mx-auto max-w-5xl">
                <section className="relative isolate overflow-hidden rounded-[2rem] border border-white/10 bg-surface-raised shadow-2xl shadow-black/30">
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -left-32 -top-32 h-80 w-80 rounded-full bg-brand/20 blur-3xl"
                    />
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -bottom-40 -right-28 h-96 w-96 rounded-full bg-ai/15 blur-3xl"
                    />

                    <div className="relative flex min-h-[34rem] flex-col items-center justify-center px-5 py-10 text-center sm:min-h-[40rem] sm:px-10 sm:py-14">
                        <p className="text-xs font-bold uppercase tracking-[0.22em] text-brand-light">
                            Endless personal radio
                        </p>
                        <h1 className="mt-3 text-5xl font-black tracking-[-0.055em] text-white sm:text-7xl">
                            My Wave
                        </h1>
                        <p className="mt-4 max-w-xl text-sm leading-6 text-content-secondary sm:text-base sm:leading-7">
                            Your likes, dislikes, and skips tune what comes
                            next. Listening and playlists help the Wave learn
                            your taste over time.
                        </p>

                        <div
                            className="mt-7 grid w-full max-w-lg grid-cols-3 gap-1 rounded-2xl border border-white/8 bg-black/30 p-1.5"
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
                                        aria-controls="wave-start"
                                        className={`min-h-11 rounded-xl px-2 py-2 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:px-4 sm:text-sm ${
                                            isActive
                                                ? "bg-white text-black shadow-lg"
                                                : "text-content-secondary hover:bg-white/8 hover:text-white"
                                        }`}
                                    >
                                        {mode.label}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="mt-3 min-h-5 text-xs text-content-muted sm:text-sm">
                            {activeModeDefinition.subtitle}
                        </p>

                        <div className="relative mt-7 grid aspect-square w-44 place-items-center sm:w-52">
                            <span
                                aria-hidden="true"
                                className="absolute inset-0 rounded-full border border-brand/15 bg-brand/5"
                            />
                            <span
                                aria-hidden="true"
                                className="absolute inset-[12%] rounded-full border border-ai/25 motion-safe:animate-pulse"
                            />
                            <button
                                id="wave-start"
                                type="button"
                                onClick={startWave}
                                disabled={!canPlay}
                                className="relative z-10 flex h-32 w-32 flex-col items-center justify-center gap-2 rounded-full bg-brand px-4 text-center text-sm font-black text-black shadow-2xl shadow-brand/25 transition duration-200 hover:scale-[1.03] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface-raised disabled:scale-100 disabled:bg-surface-highlight disabled:text-content-muted disabled:shadow-none motion-reduce:transition-none sm:h-36 sm:w-36"
                                aria-label="Play My Wave"
                            >
                                {isLoading ? (
                                    <Loader2
                                        className="h-7 w-7 animate-spin motion-reduce:animate-none"
                                        aria-hidden="true"
                                    />
                                ) : (
                                    <Play
                                        className="h-7 w-7 fill-current"
                                        aria-hidden="true"
                                    />
                                )}
                                <span>
                                    {isLoading
                                        ? "Tuning My Wave"
                                        : "Play My Wave"}
                                </span>
                            </button>
                        </div>
                        <p className="mt-5 text-xs font-medium text-content-muted sm:text-sm">
                            It keeps playing — fresh tracks are added
                            automatically while you listen.
                        </p>

                        {!isLoading && tracks.length === 0 && (
                            <div
                                className="mt-6 max-w-xl rounded-2xl border border-white/8 bg-black/25 px-5 py-4 text-sm text-content-secondary"
                                role={isError ? "alert" : "status"}
                            >
                                <p>
                                    {isError
                                        ? "Recommendations could not load. Check your connection and try again."
                                        : "Play a few songs, use like and dislike, or add a playlist so My Wave has more to work with."}
                                </p>
                                {isError && (
                                    <button
                                        type="button"
                                        onClick={() => void refetch()}
                                        aria-label="Retry My Wave recommendations"
                                        className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-brand/35 px-4 py-2 text-sm font-semibold text-brand-light transition-colors hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                    >
                                        <RotateCcw
                                            className="h-4 w-4"
                                            aria-hidden="true"
                                        />
                                        Retry
                                    </button>
                                )}
                            </div>
                        )}
                    </div>

                    {currentTrack && (
                        <section
                            aria-labelledby="wave-now-playing-title"
                            className="relative hidden border-t border-white/8 bg-black/20 px-4 py-4 backdrop-blur min-[1025px]:block min-[1025px]:px-6"
                        >
                            <div className="mx-auto flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                    <h2
                                        id="wave-now-playing-title"
                                        className="text-xs font-bold uppercase tracking-[0.16em] text-brand-light"
                                    >
                                        Now playing
                                    </h2>
                                    <p className="mt-1 text-xs text-content-muted">
                                        Like, dislike, or skip — the next picks
                                        adapt to your choice.
                                    </p>
                                </div>
                                <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
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
                            </div>
                        </section>
                    )}
                </section>
            </div>
        </main>
    );
}
