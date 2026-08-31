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
import { useAuth } from "@/lib/auth-context";
import { BRAND_SLUG } from "@/lib/brand";
import { usePlaybackStatus } from "@/lib/audio-playback-context";
import { useAudioState } from "@/lib/audio-state-context";
import { api } from "@/lib/api";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import { ru } from "@/lib/i18n/ru";
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
const WAVE_SELECTION_KEY_PREFIX = `${BRAND_SLUG}_wave_selection_v1`;

function waveSelectionStorageKey(ownerId: string): string {
    return `${WAVE_SELECTION_KEY_PREFIX}:${encodeURIComponent(ownerId)}`;
}

function readPersistedWaveSelection(ownerId: string | null): {
    mode: SupportedPersonalizedMode;
    mood: PersonalizedHomeMood | null;
} {
    if (!ownerId || typeof window === "undefined") {
        return { mode: "for-you", mood: null };
    }
    try {
        const raw = window.localStorage.getItem(
            waveSelectionStorageKey(ownerId),
        );
        if (!raw) return { mode: "for-you", mood: null };
        const parsed = JSON.parse(raw) as { mode?: unknown; mood?: unknown };
        return {
            mode:
                typeof parsed.mode === "string" &&
                WAVE_MODE_IDS.has(parsed.mode as WaveFeedMode)
                    ? (parsed.mode as SupportedPersonalizedMode)
                    : "for-you",
            mood:
                typeof parsed.mood === "string" &&
                WAVE_MOOD_IDS.has(parsed.mood as PersonalizedHomeMood)
                    ? (parsed.mood as PersonalizedHomeMood)
                    : null,
        };
    } catch {
        return { mode: "for-you", mood: null };
    }
}

function persistWaveSelection(
    ownerId: string | null,
    mode: WaveFeedMode,
    mood: WaveMood | null,
): void {
    if (!ownerId || typeof window === "undefined") return;
    try {
        window.localStorage.setItem(
            waveSelectionStorageKey(ownerId),
            JSON.stringify({ mode, mood }),
        );
    } catch {
        // The applied in-memory selection remains usable in restricted storage.
    }
}

function readWaveSelection(ownerId: string | null): {
    mode: SupportedPersonalizedMode;
    mood: PersonalizedHomeMood | null;
} {
    const persisted = readPersistedWaveSelection(ownerId);
    if (typeof window === "undefined") return persisted;
    const params = new URLSearchParams(window.location.search);
    const requestedMode = params.get("mode");
    const requestedMood = params.get("mood");
    const hasModeOverride = params.has("mode");
    const hasMoodOverride = params.has("mood");
    return {
        mode:
            requestedMode && WAVE_MODE_IDS.has(requestedMode as WaveFeedMode)
                ? (requestedMode as SupportedPersonalizedMode)
                : persisted.mode,
        mood:
            hasMoodOverride &&
            requestedMood &&
            WAVE_MOOD_IDS.has(requestedMood as PersonalizedHomeMood)
                ? (requestedMood as PersonalizedHomeMood)
                : hasModeOverride || hasMoodOverride
                  ? null
                  : persisted.mood,
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

function mixSparseRecentTracks(
    freshTracks: readonly PersonalizedTrack[],
    recentTracks: readonly PersonalizedTrack[],
): PersonalizedTrack[] {
    const fresh = uniqueTracks(freshTracks);
    if (fresh.length === 0) return uniqueTracks(recentTracks);

    const freshKeys = new Set(
        fresh.map((track) => track.youtubeVideoId || track.id),
    );
    const recent = uniqueTracks(recentTracks).filter(
        (track) => !freshKeys.has(track.youtubeVideoId || track.id),
    );
    const recentLimit = Math.min(recent.length, Math.floor(fresh.length / 5));
    if (recentLimit === 0) return fresh;

    const result: PersonalizedTrack[] = [];
    let recentIndex = 0;
    fresh.forEach((track, index) => {
        result.push(track);
        if ((index + 1) % 5 === 0 && recentIndex < recentLimit) {
            result.push(recent[recentIndex]);
            recentIndex += 1;
        }
    });
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
    return mixSparseRecentTracks(
        balancedUniqueTracks([shelves.quickPicks, shelves.discovery]),
        shelves.listenAgain,
    );
}

/** Online-first personal radio with explicit direction and feedback controls. */
export function VibeProviderFallback() {
    const { user } = useAuth();
    const ownerId = user?.id ?? null;
    const [activeMode, setActiveMode] =
        useState<SupportedPersonalizedMode>("for-you");
    const [activeMood, setActiveMood] = useState<PersonalizedHomeMood | null>(
        null,
    );
    const [isTuneOpen, setIsTuneOpen] = useState(false);
    const [retuneNotice, setRetuneNotice] = useState<
        "updated" | "kept" | "saved" | null
    >(null);
    const tuneButtonRef = useRef<HTMLButtonElement>(null);
    const readWaveSelectionOwnerRef = useRef<string | null>(null);
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
            if (
                !mounted ||
                !ownerId ||
                readWaveSelectionOwnerRef.current === ownerId
            ) {
                return;
            }
            readWaveSelectionOwnerRef.current = ownerId;
            const selection = readWaveSelection(ownerId);
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
    }, [ownerId, setWaveMode, setWaveMood, vibeMode, waveMode, waveMood]);
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

        if (isError || queue.length === 0) {
            pendingRetuneRef.current = null;
            queueMicrotask(() => setRetuneNotice("kept"));
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
        queueMicrotask(() => setRetuneNotice("updated"));
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
    useEffect(() => {
        if (!retuneNotice) return;
        const timeout = window.setTimeout(() => setRetuneNotice(null), 3200);
        return () => window.clearTimeout(timeout);
    }, [retuneNotice]);
    const activeModeDefinition =
        WAVE_MODES.find((mode) => mode.id === activeMode) ?? WAVE_MODES[0];
    const activeMoodDefinition =
        WAVE_MOODS.find((mood) => mood.id === activeMood) ?? WAVE_MOODS[0];
    const spectralField = activeMood
        ? {
              calm: {
                  primary: "bg-brand/35",
                  secondary: "bg-brand-light/25",
                  accent: "bg-ai/20",
              },
              energetic: {
                  primary: "bg-error/40",
                  secondary: "bg-ai-hover/35",
                  accent: "bg-brand/25",
              },
              focus: {
                  primary: "bg-ai/30",
                  secondary: "bg-brand/25",
                  accent: "bg-brand-light/15",
              },
              workout: {
                  primary: "bg-error/35",
                  secondary: "bg-warning/30",
                  accent: "bg-ai/25",
              },
              favorites: {
                  primary: "bg-brand/40",
                  secondary: "bg-error/25",
                  accent: "bg-ai-hover/25",
              },
              forgotten: {
                  primary: "bg-warning/30",
                  secondary: "bg-brand/30",
                  accent: "bg-ai/20",
              },
          }[activeMood]
        : activeMode === "new"
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
    const nextTracks = useMemo(() => {
        const currentIndex = currentTrack
            ? tracks.findIndex((track) => track.id === currentTrack.id)
            : -1;
        const orderedTracks =
            currentIndex >= 0
                ? [
                      ...tracks.slice(currentIndex + 1),
                      ...tracks.slice(0, currentIndex),
                  ]
                : tracks;
        return orderedTracks.slice(0, 2);
    }, [currentTrack, tracks]);
    const ambientCoverArt =
        currentTrack?.album?.coverArt ?? nextTracks[0]?.album?.coverArt ?? null;
    const ambientCoverUrl =
        ambientCoverArt &&
        !ambientCoverArt.startsWith("/") &&
        !ambientCoverArt.startsWith("data:") &&
        !ambientCoverArt.startsWith("blob:")
            ? api.getCoverArtUrl(ambientCoverArt, 960)
            : ambientCoverArt;
    const canPlay = queue.length > 0 && !isLoading;
    const startWave = useCallback(() => {
        if (queue.length === 0) return;
        setRetuneNotice(null);
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
        hasActiveWave && isPlaying ? ru.vibe.pause : ru.vibe.play;
    const closeTune = useCallback(() => {
        setIsTuneOpen(false);
        queueMicrotask(() => tuneButtonRef.current?.focus());
    }, []);
    const applyDirection = useCallback(
        (mode: WaveFeedMode, mood: WaveMood | null) => {
            const shouldRetune =
                vibeMode && (mode !== activeMode || mood !== activeMood);
            pendingRetuneRef.current = shouldRetune ? { mode, mood } : null;
            if (shouldRetune) setRetuneNotice(null);
            else if (!vibeMode) setRetuneNotice("saved");
            setActiveMode(mode);
            setActiveMood(mood);
            setWaveMode(mode);
            setWaveMood(mood);
            persistWaveSelection(ownerId, mode, mood);
            replaceWaveSelection(mode, mood);
            setIsTuneOpen(false);
            queueMicrotask(() => tuneButtonRef.current?.focus());
        },
        [activeMode, activeMood, ownerId, setWaveMode, setWaveMood, vibeMode],
    );

    return (
        <main
            data-wave-mode={activeMode}
            className="relative min-h-full overflow-x-hidden bg-surface p-0 sm:p-3 lg:p-5"
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
                className="relative isolate mx-auto flex min-h-[calc(100dvh-5rem)] max-w-[96rem] flex-col overflow-hidden bg-surface-raised shadow-2xl shadow-black/35 sm:min-h-[calc(100dvh-7rem)] sm:rounded-[2rem] sm:border sm:border-white/10"
            >
                <div
                    data-testid="wave-ambient-field"
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 overflow-hidden"
                >
                    {ambientCoverUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            data-testid="wave-artwork-ambient"
                            src={ambientCoverUrl}
                            alt=""
                            className="absolute inset-[-12%] h-[124%] w-[124%] scale-110 object-cover opacity-25 blur-[4.5rem] saturate-150 transition-opacity duration-700 motion-reduce:transition-none"
                        />
                    )}
                    <div
                        className={`absolute -left-[30%] -top-[46%] h-[96%] w-[96%] rotate-[-12deg] rounded-[42%] opacity-90 blur-[6rem] transition-[background-color,transform] duration-700 ease-out motion-reduce:transition-none ${spectralField.primary}`}
                    />
                    <div
                        className={`absolute -bottom-[50%] -right-[28%] h-[100%] w-[98%] rotate-[18deg] rounded-[40%] opacity-80 blur-[7rem] transition-[background-color,transform] duration-700 ease-out motion-reduce:transition-none ${spectralField.secondary}`}
                    />
                    <div
                        className={`absolute left-[30%] top-[18%] h-[64%] w-[58%] -rotate-12 rounded-[48%] opacity-65 blur-[5rem] transition-[background-color,transform] duration-700 ease-out motion-reduce:transition-none ${spectralField.accent}`}
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/15 to-black/60" />
                    <div className="absolute inset-0 bg-[linear-gradient(115deg,transparent_15%,rgb(255_255_255/0.035)_48%,transparent_72%)]" />
                </div>

                <div className="relative flex flex-1 flex-col items-center justify-start px-5 pb-8 pt-7 text-center sm:px-10 sm:pb-10 sm:pt-9 lg:px-16">
                    <div
                        data-testid="wave-continuity-status"
                        className="wave-material mb-4 inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3.5 py-2 text-xs font-semibold tracking-wide text-content-body backdrop-blur-xl"
                    >
                        <AudioWaveform
                            className="h-4 w-4 text-brand-light"
                            aria-hidden="true"
                        />
                        {ru.vibe.continuity}
                    </div>
                    <header className="max-w-2xl">
                        <p className="text-[0.68rem] font-bold uppercase tracking-[0.22em] text-brand-light sm:text-xs">
                            {ru.vibe.personalRadio}
                        </p>
                        <h1
                            id="wave-title"
                            className="mt-2 text-4xl font-black leading-[0.94] tracking-[-0.055em] text-white sm:text-5xl lg:text-6xl"
                        >
                            {ru.vibe.title}
                        </h1>
                        <p
                            data-testid="wave-description"
                            className="mx-auto mt-3 line-clamp-2 max-w-xl text-sm leading-6 text-content-secondary sm:text-base"
                        >
                            {ru.vibe.subtitle}
                        </p>
                    </header>

                    <div
                        data-testid="wave-orbit-stage"
                        className="relative mt-6 grid h-40 w-40 place-items-center sm:h-44 sm:w-44"
                    >
                        <span
                            aria-hidden="true"
                            className={`absolute inset-1 rounded-[44%] border border-white/15 transition-[transform,opacity] duration-700 ease-out motion-reduce:transition-none ${hasActiveWave && isPlaying ? "rotate-12 scale-100 opacity-100" : "-rotate-6 scale-90 opacity-55"}`}
                        />
                        <span
                            aria-hidden="true"
                            className={`absolute inset-5 rounded-[46%] border border-white/10 transition-[transform,opacity] duration-700 ease-out motion-reduce:transition-none ${hasActiveWave && isPlaying ? "-rotate-12 scale-105 opacity-100" : "rotate-6 scale-95 opacity-60"}`}
                        />
                        <button
                            id="wave-start"
                            data-testid="wave-main-toggle"
                            type="button"
                            onClick={toggleWavePlayback}
                            disabled={!hasActiveWave && !canPlay}
                            aria-label={primaryControlLabel}
                            aria-pressed={hasActiveWave && isPlaying}
                            className="group relative z-10 flex h-28 min-h-20 w-28 min-w-20 flex-col items-center justify-center gap-1.5 rounded-full bg-white px-4 text-center text-sm font-black text-black shadow-2xl shadow-black/40 transition-[transform,background-color,box-shadow] duration-200 ease-out hover:scale-[1.035] hover:bg-brand-light hover:shadow-brand/20 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-transparent disabled:scale-100 disabled:bg-white/15 disabled:text-content-muted motion-reduce:transition-none sm:h-32 sm:w-32 sm:text-base"
                        >
                            {!hasActiveWave && isLoading ? (
                                <Loader2
                                    className="h-8 w-8 animate-spin motion-reduce:animate-none"
                                    aria-hidden="true"
                                />
                            ) : hasActiveWave && isPlaying ? (
                                <Pause
                                    className="h-9 w-9 fill-current"
                                    aria-hidden="true"
                                />
                            ) : (
                                <Play
                                    className="ml-1 h-9 w-9 fill-current"
                                    aria-hidden="true"
                                />
                            )}
                            <span>
                                {!hasActiveWave && isLoading
                                    ? ru.vibe.tuning
                                    : primaryControlLabel}
                            </span>
                        </button>
                    </div>

                    <div
                        data-testid="wave-current-tuning"
                        className="mt-5 flex w-full max-w-2xl flex-wrap items-center justify-center gap-2"
                    >
                        <p
                            aria-live="polite"
                            className="wave-material flex min-h-11 flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-full border border-white/10 bg-black/20 px-4 py-2 text-sm font-semibold text-content backdrop-blur-xl"
                        >
                            <span className="text-content-muted">
                                {ru.vibe.directionLabel}
                            </span>
                            <span>{activeModeDefinition.shortLabel}</span>
                            <span aria-hidden="true" className="text-white/25">
                                ·
                            </span>
                            <span className="text-content-muted">
                                {ru.vibe.moodLabel}
                            </span>
                            <span className="font-medium text-content-secondary">
                                {activeMoodDefinition.label}
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
                            {ru.vibe.tune}
                        </button>
                    </div>

                    {retuneNotice && (
                        <p
                            role="status"
                            aria-live="polite"
                            className={`wave-material mt-3 rounded-full border px-4 py-2 text-sm font-semibold backdrop-blur-xl ${retuneNotice === "updated" || retuneNotice === "saved" ? "border-success/30 bg-success/10 text-success" : "border-warning/30 bg-warning/10 text-warning"}`}
                        >
                            {retuneNotice === "saved"
                                ? "Настройка сохранена — она применится при следующем запуске."
                                : retuneNotice === "updated"
                                  ? ru.vibe.updated
                                  : ru.vibe.updateFailed}
                        </p>
                    )}

                    {!isLoading && tracks.length === 0 && (
                        <div
                            className="wave-material mt-7 max-w-lg rounded-2xl border border-white/10 bg-black/35 px-5 py-4 text-sm leading-6 text-content-secondary backdrop-blur-xl"
                            role={isError ? "alert" : "status"}
                        >
                            <p>
                                {isError ? ru.vibe.loadFailed : ru.vibe.empty}
                            </p>
                            {isError && (
                                <button
                                    type="button"
                                    onClick={() => void refetch()}
                                    aria-label={ru.vibe.retryAria}
                                    className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none"
                                >
                                    <RotateCcw
                                        className="h-4 w-4"
                                        aria-hidden="true"
                                    />
                                    {ru.common.retry}
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {(currentTrack || nextTracks.length > 0) && (
                    <div className="wave-material relative border-t border-white/10 bg-black/30 px-4 py-4 backdrop-blur-2xl sm:px-6 min-[1025px]:px-8">
                        <div className="mx-auto grid max-w-6xl gap-4 min-[900px]:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.75fr)] min-[900px]:items-center">
                            {currentTrack ? (
                                <section
                                    aria-labelledby="wave-now-playing-title"
                                    className="min-w-0 rounded-2xl bg-white/[0.045] p-3 sm:p-4"
                                >
                                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
                                        <div className="min-w-0">
                                            <h2
                                                id="wave-now-playing-title"
                                                className="text-xs font-bold uppercase tracking-[0.16em] text-brand-light"
                                            >
                                                {ru.vibe.nowPlaying}
                                            </h2>
                                            <p className="mt-1 text-xs text-content-muted">
                                                {ru.vibe.feedbackHint}
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
                                                onClick={() =>
                                                    advanceQueue("manual")
                                                }
                                                aria-label={ru.vibe.skipAria}
                                                className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-2 text-sm font-semibold text-content-body transition-[transform,background-color,border-color] duration-200 hover:border-white/20 hover:bg-white/10 hover:text-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none"
                                            >
                                                <SkipForward
                                                    className="h-4 w-4"
                                                    aria-hidden="true"
                                                />
                                                {ru.vibe.skip}
                                            </button>
                                        </div>
                                    </div>
                                </section>
                            ) : (
                                <div className="rounded-2xl bg-white/[0.04] px-4 py-3 text-left">
                                    <p className="text-sm font-semibold text-content">
                                        {ru.vibe.ready}
                                    </p>
                                    <p className="mt-1 text-xs leading-5 text-content-muted">
                                        {ru.vibe.readyDescription}
                                    </p>
                                </div>
                            )}

                            {nextTracks.length > 0 && (
                                <aside
                                    data-testid="wave-next-preview"
                                    aria-label={ru.vibe.upNextAria}
                                    className="min-w-0"
                                >
                                    <div className="flex items-baseline justify-between gap-3">
                                        <h2 className="text-xs font-bold uppercase tracking-[0.16em] text-content-body">
                                            {hasActiveWave
                                                ? ru.vibe.upNext
                                                : ru.vibe.startsHere}
                                        </h2>
                                        <span className="text-xs text-content-muted">
                                            {ru.vibe.keepsGoing}
                                        </span>
                                    </div>
                                    <div className="mt-2 grid gap-1.5">
                                        {nextTracks.map((track) => {
                                            const rawCover =
                                                track.album?.coverArt ?? null;
                                            const cover =
                                                rawCover &&
                                                !rawCover.startsWith("/") &&
                                                !rawCover.startsWith("data:") &&
                                                !rawCover.startsWith("blob:")
                                                    ? api.getCoverArtUrl(
                                                          rawCover,
                                                          96,
                                                      )
                                                    : rawCover;
                                            return (
                                                <div
                                                    key={track.id}
                                                    className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                                                >
                                                    {cover ? (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <img
                                                            src={cover}
                                                            alt=""
                                                            loading="lazy"
                                                            className="h-9 w-9 shrink-0 rounded-lg object-cover"
                                                        />
                                                    ) : (
                                                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/[0.07] text-content-muted">
                                                            <AudioWaveform
                                                                className="h-4 w-4"
                                                                aria-hidden="true"
                                                            />
                                                        </span>
                                                    )}
                                                    <span className="min-w-0">
                                                        <span className="block truncate text-sm font-semibold text-content">
                                                            {track.title}
                                                        </span>
                                                        {track.artist?.name && (
                                                            <span className="block truncate text-xs text-content-muted">
                                                                {
                                                                    track.artist
                                                                        .name
                                                                }
                                                            </span>
                                                        )}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </aside>
                            )}
                        </div>
                    </div>
                )}
            </section>

            {isTuneOpen && (
                <WaveDirectionSheet
                    activeMode={activeMode}
                    activeMood={activeMood}
                    isWaveActive={vibeMode}
                    onApply={applyDirection}
                    onClose={closeTune}
                />
            )}
        </main>
    );
}
