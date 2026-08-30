"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AudioWaveform,
    Loader2,
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
    const pendingRetuneRef = useRef<{
        mode: WaveFeedMode;
        mood: WaveMood | null;
    } | null>(null);
    const { advanceQueue, playTracks, setUpcoming } = useAudioControls();
    const {
        currentTrack,
        vibeMode,
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
            if (!mounted) return;
            const selection = readWaveSelection();
            setActiveMode(selection.mode);
            setActiveMood(selection.mood);
            setWaveMood(selection.mood);
        });
        return () => {
            mounted = false;
        };
    }, [setWaveMood]);
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
            isLoading
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
                  primary: "bg-ai/25",
                  secondary: "bg-brand-light/15",
                  ring: "border-ai-hover/30",
              }
            : activeMode === "familiar"
              ? {
                    primary: "bg-brand/25",
                    secondary: "bg-brand-light/20",
                    ring: "border-brand-light/30",
                }
              : {
                    primary: "bg-brand/20",
                    secondary: "bg-ai/15",
                    ring: "border-brand/25",
                };
    const canPlay = queue.length > 0 && !isLoading;
    const startWave = useCallback(() => {
        if (queue.length === 0) return;
        setWaveMode(activeMode);
        setWaveMood(activeMood);
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
        setWaveMood,
    ]);
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
            className="relative min-h-full overflow-x-hidden bg-surface px-3 pb-7 pt-3 sm:px-6 sm:pb-9 sm:pt-7"
        >
            <div className="mx-auto max-w-6xl">
                <section
                    data-testid="wave-surface"
                    aria-labelledby="wave-title"
                    className="relative isolate overflow-hidden rounded-[1.75rem] border border-white/10 bg-surface-raised shadow-2xl shadow-black/30 sm:rounded-[2.5rem]"
                >
                    <div
                        aria-hidden="true"
                        className={`pointer-events-none absolute -left-48 -top-48 h-[34rem] w-[34rem] rounded-full blur-3xl transition-colors duration-700 motion-reduce:transition-none ${spectralField.primary}`}
                    />
                    <div
                        aria-hidden="true"
                        className={`pointer-events-none absolute -bottom-56 -right-40 h-[38rem] w-[38rem] rounded-full blur-3xl transition-colors duration-700 motion-reduce:transition-none ${spectralField.secondary}`}
                    />
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -right-[12%] top-[8%] h-[82%] w-[68%] rotate-12 rounded-[48%] border border-white/[0.035] bg-white/[0.015]"
                    />
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute -bottom-[18%] left-[18%] h-[48%] w-[58%] -rotate-12 rounded-[48%] border border-white/[0.025]"
                    />

                    <div className="relative grid min-h-[39rem] items-center gap-x-8 gap-y-7 px-5 py-9 sm:px-9 sm:py-12 lg:min-h-[42rem] lg:grid-cols-[minmax(0,0.85fr)_minmax(22rem,1.15fr)] lg:grid-rows-[auto_1fr] lg:px-14 lg:py-14">
                        <header className="order-1 text-center lg:col-start-1 lg:row-start-1 lg:text-left">
                            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-1.5 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-brand-light backdrop-blur-sm">
                                <span
                                    aria-hidden="true"
                                    className="h-1.5 w-1.5 rounded-full bg-brand-hover shadow-[0_0_0.75rem_currentColor]"
                                />
                                Continuous personal radio
                            </div>
                            <h1
                                id="wave-title"
                                className="mt-5 text-5xl font-black tracking-[-0.065em] text-white sm:text-7xl lg:text-[5.35rem] lg:leading-[0.92]"
                            >
                                My Wave
                            </h1>
                            <p className="mx-auto mt-5 max-w-xl text-sm leading-6 text-content-secondary sm:text-base sm:leading-7 lg:mx-0 lg:max-w-md">
                                Your likes, dislikes, and skips shape the next
                                turn. Listening and playlists keep every
                                account&apos;s Wave personal.
                            </p>
                        </header>

                        <div
                            data-testid="wave-signal-dial"
                            className="order-2 flex min-w-0 flex-col items-center lg:col-start-2 lg:row-span-2 lg:row-start-1"
                        >
                            <div className="relative grid h-56 w-56 place-items-center min-[360px]:h-64 min-[360px]:w-64 sm:h-80 sm:w-80 lg:h-[23rem] lg:w-[23rem]">
                                <span
                                    aria-hidden="true"
                                    className={`absolute inset-0 rounded-full border bg-black/10 transition-colors duration-700 motion-reduce:transition-none ${spectralField.ring}`}
                                />
                                <span
                                    aria-hidden="true"
                                    className="absolute inset-[8%] rotate-[18deg] rounded-full border border-dashed border-white/15"
                                />
                                <span
                                    aria-hidden="true"
                                    className="absolute inset-[18%] rounded-full border border-ai/25 motion-safe:animate-pulse"
                                />
                                <span
                                    aria-hidden="true"
                                    className="absolute left-1/2 top-[4%] h-2 w-2 -translate-x-1/2 rounded-full bg-brand-light shadow-[0_0_1.25rem_currentColor]"
                                />
                                <span
                                    aria-hidden="true"
                                    className="absolute bottom-[9%] right-[19%] rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-[0.14em] text-content-secondary backdrop-blur"
                                >
                                    Live
                                </span>
                                <button
                                    id="wave-start"
                                    type="button"
                                    onClick={startWave}
                                    disabled={!canPlay}
                                    className="relative z-10 flex h-36 min-h-36 w-36 min-w-36 flex-col items-center justify-center gap-2 rounded-full bg-brand px-4 text-center text-sm font-black text-black shadow-2xl shadow-brand/30 transition duration-200 hover:scale-[1.035] hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface-raised disabled:scale-100 disabled:bg-surface-highlight disabled:text-content-muted disabled:shadow-none motion-reduce:transition-none sm:h-40 sm:w-40"
                                    aria-label="Play My Wave"
                                >
                                    {isLoading ? (
                                        <Loader2
                                            className="h-8 w-8 animate-spin motion-reduce:animate-none"
                                            aria-hidden="true"
                                        />
                                    ) : (
                                        <Play
                                            className="h-8 w-8 fill-current"
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
                            <p className="mt-4 max-w-sm text-center text-xs font-medium leading-5 text-content-muted sm:text-sm">
                                Starts with a few picks, then keeps finding what
                                comes next. It keeps playing while fresh
                                recommendations arrive.
                            </p>
                        </div>

                        <div
                            data-testid="wave-direction-card"
                            className="order-3 min-w-0 rounded-[1.5rem] border border-white/10 bg-black/30 p-4 text-left backdrop-blur-md sm:p-5 lg:col-start-1 lg:row-start-2 lg:self-start"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 whitespace-normal break-words">
                                    <p className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-content-muted">
                                        Direction for now
                                    </p>
                                    <p
                                        aria-live="polite"
                                        className="mt-1 text-lg font-black tracking-[-0.02em] text-content"
                                    >
                                        {activeModeDefinition.shortLabel}
                                        <span className="font-semibold text-content-secondary">
                                            {` · ${activeMoodDefinition.label}`}
                                        </span>
                                    </p>
                                </div>
                                <button
                                    ref={tuneButtonRef}
                                    type="button"
                                    onClick={() => setIsTuneOpen(true)}
                                    aria-haspopup="dialog"
                                    aria-expanded={isTuneOpen}
                                    className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-brand/35 bg-brand/10 px-4 py-2 text-sm font-bold text-brand-light transition-colors hover:border-brand/60 hover:bg-brand/15 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                >
                                    <AudioWaveform
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                    Tune
                                </button>
                            </div>
                            <p className="mt-3 text-sm leading-6 text-content-secondary">
                                {activeModeDefinition.subtitle}{" "}
                                {activeMoodDefinition.subtitle}
                            </p>

                            {!isLoading && tracks.length === 0 && (
                                <div
                                    className="mt-4 rounded-xl border border-white/8 bg-black/25 px-4 py-3 text-sm text-content-secondary"
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
                    </div>

                    {currentTrack && (
                        <section
                            aria-labelledby="wave-now-playing-title"
                            className="relative hidden border-t border-white/8 bg-black/25 px-4 py-4 backdrop-blur min-[1025px]:block min-[1025px]:px-8"
                        >
                            <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
