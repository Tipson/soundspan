"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AudioWaveform,
    Loader2,
    Pause,
    Play,
    RotateCcw,
    SkipForward,
} from "lucide-react";
import { usePersonalizedHomeFeed } from "@/features/home/hooks/usePersonalizedHomeFeed";
import type {
    PersonalizedHomeMode,
    PersonalizedHomeMood,
    PersonalizedTrack,
} from "@/features/home/types";
import { useAudioControls } from "@/lib/audio-controls-context";
import { usePlaybackStatus } from "@/lib/audio-playback-context";
import { useAudioState } from "@/lib/audio-state-context";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import { NowPlayingConnected } from "./NowPlayingConnected";
import {
    WaveDirectionSheet,
    WAVE_MOODS,
    WAVE_MODES,
    type WaveFeedMode,
    type WaveMood,
} from "./WaveDirectionSheet";

type SupportedPersonalizedMode = Extract<PersonalizedHomeMode, WaveFeedMode>;

const WAVE_MODE_IDS = new Set<WaveFeedMode>(["for-you", "new", "familiar"]);
const WAVE_MOOD_IDS = new Set<PersonalizedHomeMood>([
    "calm",
    "energetic",
    "focus",
    "workout",
    "favorites",
    "forgotten",
]);

function readWaveSelection(): {
    mode: SupportedPersonalizedMode;
    mood: PersonalizedHomeMood | null;
} {
    if (typeof window === "undefined") {
        return { mode: "for-you", mood: null };
    }
    const params = new URLSearchParams(window.location.search);
    const requestedMode = params.get("mode");
    const requestedMood = params.get("mood");
    return {
        mode:
            requestedMode && WAVE_MODE_IDS.has(requestedMode as WaveFeedMode)
                ? (requestedMode as SupportedPersonalizedMode)
                : "for-you",
        mood:
            requestedMood &&
            WAVE_MOOD_IDS.has(requestedMood as PersonalizedHomeMood)
                ? (requestedMood as PersonalizedHomeMood)
                : null,
    };
}

function replaceWaveSelection(
    mode: WaveFeedMode,
    mood: PersonalizedHomeMood | null,
): void {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("mode", mode);
    if (mood) url.searchParams.set("mood", mood);
    else url.searchParams.delete("mood");
    window.history.replaceState(window.history.state, "", url);
}

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
    const [activeMode, setActiveMode] =
        useState<SupportedPersonalizedMode>("for-you");
    const [activeMood, setActiveMood] = useState<PersonalizedHomeMood | null>(
        null,
    );
    const [isTuneOpen, setIsTuneOpen] = useState(false);
    const tuneButtonRef = useRef<HTMLButtonElement>(null);
    const didReadWaveSelectionRef = useRef(false);
    const pendingRetuneRef = useRef<{
        mode: WaveFeedMode;
        mood: WaveMood | null;
    } | null>(null);
    const { advanceQueue, pause, play, playTracks, setUpcoming } =
        useAudioControls();
    const { isPlaying } = usePlaybackStatus();
    const {
        currentTrack,
        vibeMode,
        waveMode,
        waveMood,
        setIsShuffle,
        setShuffleIndices,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
        setWaveMode,
        setWaveMood,
    } = useAudioState();
    const { data, isLoading, isError, refetch } = usePersonalizedHomeFeed(
        12,
        true,
        activeMode,
        activeMood,
    );

    useEffect(() => {
        let mounted = true;
        queueMicrotask(() => {
            if (!mounted || didReadWaveSelectionRef.current) return;
            didReadWaveSelectionRef.current = true;
            const selection = readWaveSelection();
            pendingRetuneRef.current =
                vibeMode &&
                (selection.mode !== waveMode || selection.mood !== waveMood)
                    ? selection
                    : null;
            setActiveMode(selection.mode);
            setActiveMood(selection.mood);
            setWaveMode(selection.mode);
            setWaveMood(selection.mood);
        });
        return () => {
            mounted = false;
        };
    }, [setWaveMode, setWaveMood, vibeMode, waveMode, waveMood]);
    const tracks = useMemo(
        () => selectWaveTracks(data?.shelves, activeMode),
        [activeMode, data?.shelves],
    );
    const queue = useMemo(() => tracks.map(toProviderPlaybackTrack), [tracks]);

    useEffect(() => {
        const pendingRetune = pendingRetuneRef.current;
        if (!pendingRetune) return;
        if (!vibeMode) {
            pendingRetuneRef.current = null;
            return;
        }
        if (
            pendingRetune.mode !== activeMode ||
            pendingRetune.mood !== activeMood ||
            isLoading ||
            isError ||
            queue.length === 0
        ) {
            return;
        }

        pendingRetuneRef.current = null;
        const currentTrackId = currentTrack?.id ?? null;
        const upcoming = currentTrackId
            ? queue.filter((track) => track.id !== currentTrackId)
            : queue;

        // Keep the audible track intact, but replace every later item with
        // the newly ranked direction as soon as its feed is ready.
        setUpcoming(upcoming, true);
        setVibeSourceFeatures(null);
        setVibeQueueIds(
            currentTrackId
                ? [currentTrackId, ...upcoming.map((track) => track.id)]
                : upcoming.map((track) => track.id),
        );
    }, [
        activeMode,
        activeMood,
        currentTrack?.id,
        isError,
        isLoading,
        queue,
        setUpcoming,
        setVibeQueueIds,
        setVibeSourceFeatures,
        vibeMode,
    ]);
    const activeModeDefinition =
        WAVE_MODES.find((mode) => mode.id === activeMode) ?? WAVE_MODES[0];
    const activeMoodDefinition =
        WAVE_MOODS.find((mood) => mood.id === activeMood) ?? WAVE_MOODS[0];
    const spectralField =
        activeMode === "new"
            ? {
                  primary: "bg-ai/45",
                  secondary: "bg-brand-light/30",
                  accent: "bg-ai-hover/25",
              }
            : activeMode === "familiar"
              ? {
                    primary: "bg-brand/40",
                    secondary: "bg-brand-light/30",
                    accent: "bg-ai/20",
                }
              : {
                    primary: "bg-brand/35",
                    secondary: "bg-ai/30",
                    accent: "bg-brand-light/20",
                };
    const canPlay = queue.length > 0 && !isLoading;
    const startWave = useCallback(() => {
        if (queue.length === 0) return;
        setWaveMode(activeMode);
        setWaveMood(activeMood);
        setIsShuffle(false);
        setShuffleIndices([]);
        playTracks(queue, 0, true);
        setVibeMode(true);
        setVibeSourceFeatures(null);
        setVibeQueueIds(queue.map((track) => track.id));
    }, [
        playTracks,
        queue,
        activeMode,
        activeMood,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
        setIsShuffle,
        setShuffleIndices,
        setWaveMode,
        setWaveMood,
    ]);
    const hasActiveWave = vibeMode && currentTrack !== null;
    const toggleWavePlayback = useCallback(() => {
        if (!hasActiveWave) {
            startWave();
            return;
        }
        if (isPlaying) pause();
        else play();
    }, [hasActiveWave, isPlaying, pause, play, startWave]);
    const primaryControlLabel =
        hasActiveWave && isPlaying ? "Pause My Wave" : "Play My Wave";
    const closeTune = useCallback(() => {
        setIsTuneOpen(false);
        queueMicrotask(() => tuneButtonRef.current?.focus());
    }, []);
    const applyDirection = useCallback(
        (mode: WaveFeedMode, mood: WaveMood | null) => {
            pendingRetuneRef.current =
                vibeMode && (mode !== activeMode || mood !== activeMood)
                    ? { mode, mood }
                    : null;
            setActiveMode(mode);
            setActiveMood(mood);
            setWaveMode(mode);
            setWaveMood(mood);
            replaceWaveSelection(mode, mood);
            setIsTuneOpen(false);
            queueMicrotask(() => tuneButtonRef.current?.focus());
        },
        [activeMode, activeMood, setWaveMode, setWaveMood, vibeMode],
    );

    return (
        <main
            data-wave-mode={activeMode}
            className="relative min-h-full overflow-x-hidden bg-surface p-2.5 sm:p-5 lg:p-6"
        >
            <style>{`
                @media (prefers-reduced-transparency: reduce) {
                    .wave-material {
                        background-color: var(--color-surface-raised) !important;
                        -webkit-backdrop-filter: none !important;
                        backdrop-filter: none !important;
                    }
                }
            `}</style>
            <section
                data-testid="wave-surface"
                aria-labelledby="wave-title"
                className="relative isolate mx-auto flex min-h-[calc(100dvh-7rem)] max-w-7xl flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-surface-raised shadow-2xl shadow-black/35 sm:min-h-[calc(100dvh-8rem)] sm:rounded-[2.5rem]"
            >
                <div
                    data-testid="wave-ambient-field"
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 overflow-hidden"
                >
                    <div
                        className={`absolute -left-[24%] -top-[38%] h-[82%] w-[88%] rounded-[46%] opacity-90 blur-[7rem] transition-[background-color,transform] duration-700 ease-out motion-reduce:transition-none ${spectralField.primary}`}
                    />
                    <div
                        className={`absolute -bottom-[42%] -right-[28%] h-[88%] w-[92%] rounded-[44%] opacity-80 blur-[8rem] transition-[background-color,transform] duration-700 ease-out motion-reduce:transition-none ${spectralField.secondary}`}
                    />
                    <div
                        className={`absolute left-[35%] top-[28%] h-[54%] w-[48%] -rotate-12 rounded-[50%] opacity-65 blur-[6rem] transition-[background-color,transform] duration-700 ease-out motion-reduce:transition-none ${spectralField.accent}`}
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/5 to-black/45" />
                </div>

                <div className="relative flex flex-1 flex-col items-center justify-center px-5 py-12 text-center sm:px-10 sm:py-16 lg:px-16">
                    <header className="max-w-2xl">
                        <p className="text-[0.68rem] font-bold uppercase tracking-[0.2em] text-brand-light sm:text-xs">
                            Your personal radio
                        </p>
                        <h1
                            id="wave-title"
                            className="mt-4 text-5xl font-black leading-[0.92] tracking-[-0.065em] text-white sm:text-7xl lg:text-[6.2rem]"
                        >
                            My Wave
                        </h1>
                        <p className="mx-auto mt-5 max-w-xl text-sm leading-6 text-content-secondary sm:text-base sm:leading-7">
                            A personal flow that keeps finding what comes next.
                            It keeps playing as fresh picks arrive; your
                            listening, likes, dislikes, and skips gently change
                            its course.
                        </p>
                    </header>

                    <button
                        id="wave-start"
                        data-testid="wave-main-toggle"
                        type="button"
                        onClick={toggleWavePlayback}
                        disabled={!hasActiveWave && !canPlay}
                        aria-label={primaryControlLabel}
                        aria-pressed={hasActiveWave && isPlaying}
                        className="group mt-9 flex h-24 min-h-20 w-24 min-w-20 flex-col items-center justify-center gap-1.5 rounded-full bg-white px-3 text-center text-xs font-black text-black shadow-2xl shadow-black/35 transition-[transform,background-color] duration-200 ease-out hover:scale-[1.035] hover:bg-brand-light active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-transparent disabled:scale-100 disabled:bg-white/15 disabled:text-content-muted motion-reduce:transition-none sm:h-28 sm:w-28 sm:text-sm"
                    >
                        {!hasActiveWave && isLoading ? (
                            <Loader2
                                className="h-7 w-7 animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                            />
                        ) : hasActiveWave && isPlaying ? (
                            <Pause
                                className="h-7 w-7 fill-current"
                                aria-hidden="true"
                            />
                        ) : (
                            <Play
                                className="h-7 w-7 fill-current"
                                aria-hidden="true"
                            />
                        )}
                        <span>
                            {!hasActiveWave && isLoading
                                ? "Tuning My Wave"
                                : primaryControlLabel}
                        </span>
                    </button>

                    <div
                        data-testid="wave-current-tuning"
                        className="mt-8 flex max-w-xl flex-col items-center gap-3"
                    >
                        <p
                            aria-live="polite"
                            className="text-sm font-semibold text-content sm:text-base"
                        >
                            {activeModeDefinition.shortLabel}
                            <span className="font-medium text-content-secondary">
                                {` · ${activeMoodDefinition.label}`}
                            </span>
                        </p>
                        <button
                            ref={tuneButtonRef}
                            type="button"
                            onClick={() => setIsTuneOpen(true)}
                            aria-haspopup="dialog"
                            aria-expanded={isTuneOpen}
                            className="wave-material inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/15 bg-black/20 px-4 py-2 text-sm font-bold text-white backdrop-blur-xl transition-[transform,background-color,border-color] duration-200 hover:border-white/25 hover:bg-black/35 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none"
                        >
                            <AudioWaveform
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                            Tune
                        </button>
                    </div>

                    {!isLoading && tracks.length === 0 && (
                        <div
                            className="wave-material mt-7 max-w-lg rounded-2xl border border-white/10 bg-black/35 px-5 py-4 text-sm leading-6 text-content-secondary backdrop-blur-xl"
                            role={isError ? "alert" : "status"}
                        >
                            <p>
                                {isError
                                    ? "My Wave could not load. Check your connection and try again."
                                    : "Play a few songs, use like and dislike, or add a playlist to shape My Wave."}
                            </p>
                            {isError && (
                                <button
                                    type="button"
                                    onClick={() => void refetch()}
                                    aria-label="Retry My Wave recommendations"
                                    className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none"
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
                        className="wave-material relative border-t border-white/10 bg-black/25 px-4 py-3 backdrop-blur-xl sm:px-5 sm:py-4 min-[1025px]:px-8"
                    >
                        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
                            <div className="min-w-0">
                                <h2
                                    id="wave-now-playing-title"
                                    className="text-xs font-bold uppercase tracking-[0.16em] text-brand-light"
                                >
                                    Now playing
                                </h2>
                                <p className="mt-1 text-xs text-content-muted">
                                    Your feedback changes what comes next.
                                </p>
                            </div>
                            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                                <NowPlayingConnected
                                    track={currentTrack}
                                    onMapPresent={false}
                                    moodColor={null}
                                    onFlyTo={() => undefined}
                                    appearance="wave"
                                    showPlaybackToggle={false}
                                />
                                <button
                                    type="button"
                                    onClick={() => advanceQueue("manual")}
                                    aria-label="Skip current track"
                                    className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-semibold text-content-body transition-[transform,background-color,border-color] duration-200 hover:border-white/20 hover:bg-white/10 hover:text-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none"
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

            {isTuneOpen && (
                <WaveDirectionSheet
                    activeMode={activeMode}
                    activeMood={activeMood}
                    onApply={applyDirection}
                    onClose={closeTune}
                />
            )}
        </main>
    );
}
