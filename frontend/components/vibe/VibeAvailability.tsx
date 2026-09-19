"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioWaveform, Loader2, Pause, Play, RotateCcw } from "lucide-react";
import { usePersonalizedHomeFeed } from "@/features/home/hooks/usePersonalizedHomeFeed";
import { selectWaveTracks } from "@/features/home/selectWaveTracks";
import type {
    PersonalizedHomeMood,
    PersonalizedHomeLanguage,
} from "@/features/home/types";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAuth } from "@/lib/auth-context";
import { useWaveStartWarmup } from "@/hooks/useWaveStartWarmup";
import { usePlaybackStatus } from "@/lib/audio-playback-context";
import { useAudioState } from "@/lib/audio-state-context";
import { isListenTogetherActiveOrPending } from "@/lib/listen-together-session";
import { api } from "@/lib/api";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import { ru } from "@/lib/i18n/ru";
import {
    persistWaveSelection,
    readWaveSelection,
    replaceWaveSelection,
    type WaveSelectionMode,
} from "@/lib/waveSelection";
import { VibeAmbientMotion } from "./VibeAmbientMotion";
import {
    WaveDirectionSheet,
    WAVE_MOODS,
    WAVE_MODES,
    WAVE_LANGUAGES,
    type WaveFeedMode,
    type WaveMood,
} from "./WaveDirectionSheet";

type SupportedPersonalizedMode = WaveSelectionMode;

// A Wave retune can fan out into several provider radio requests and a fresh
// stream extraction. Keep rapid successive Apply actions latest-wins before
// any provider work starts instead of turning UI experimentation into a
// playback-failure cascade.
const RETUNE_REQUEST_DEBOUNCE_MS = 300;

/** Online-first personal radio with explicit direction and feedback controls. */
export function VibeProviderFallback() {
    const { user } = useAuth();
    const ownerId = user?.id ?? null;
    const [activeMode, setActiveMode] =
        useState<SupportedPersonalizedMode>("for-you");
    const [activeMood, setActiveMood] = useState<PersonalizedHomeMood | null>(
        null,
    );
    const [requestedMode, setRequestedMode] =
        useState<SupportedPersonalizedMode>("for-you");
    const [activeLanguage, setActiveLanguage] =
        useState<PersonalizedHomeLanguage>("any");
    const [requestedLanguage, setRequestedLanguage] =
        useState<PersonalizedHomeLanguage>("any");
    const [requestedMood, setRequestedMood] =
        useState<PersonalizedHomeMood | null>(null);
    const [isTuneOpen, setIsTuneOpen] = useState(false);
    const [retuneNotice, setRetuneNotice] = useState<
        "updated" | "kept" | "saved" | null
    >(null);
    const tuneButtonRef = useRef<HTMLButtonElement>(null);
    const readWaveSelectionOwnerRef = useRef<string | null>(null);
    const retuneGenerationRef = useRef(0);
    const [pendingRetune, setPendingRetune] = useState<{
        mode: WaveFeedMode;
        mood: WaveMood | null;
        language: PersonalizedHomeLanguage;
        generation: number;
    } | null>(null);
    const { pause, play, playTracks } = useAudioControls();
    const { isPlaying } = usePlaybackStatus();
    const {
        currentTrack,
        vibeMode,
        waveMode,
        waveMood,
        waveLanguage = "any",
        setIsShuffle,
        setShuffleIndices,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
        setWaveMode,
        setWaveMood,
        setWaveLanguage,
    } = useAudioState();
    const { data, isLoading, isError, refetch } = usePersonalizedHomeFeed(
        12,
        true,
        requestedMode,
        requestedMood,
        "wave",
        requestedLanguage,
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
            const shouldRetuneActiveWave =
                vibeMode &&
                (selection.mode !== waveMode ||
                    selection.mood !== waveMood ||
                    selection.language !== waveLanguage);
            if (shouldRetuneActiveWave) {
                retuneGenerationRef.current += 1;
                setPendingRetune({
                    ...selection,
                    generation: retuneGenerationRef.current,
                });
            } else {
                setPendingRetune(null);
                setRequestedMode(selection.mode);
                setRequestedMood(selection.mood);
                setRequestedLanguage(selection.language);
            }
            setActiveMode(selection.mode);
            setActiveMood(selection.mood);
            setActiveLanguage(selection.language);
            if (!shouldRetuneActiveWave) {
                setWaveMode(selection.mode);
                setWaveMood(selection.mood);
                setWaveLanguage(selection.language);
            }
        });
        return () => {
            mounted = false;
        };
    }, [
        ownerId,
        setWaveMode,
        setWaveMood,
        setWaveLanguage,
        vibeMode,
        waveMode,
        waveMood,
        waveLanguage,
    ]);
    useEffect(() => {
        if (!pendingRetune) return;
        const generation = pendingRetune.generation;
        const timeout = window.setTimeout(() => {
            if (retuneGenerationRef.current !== generation) return;
            setRequestedMode(pendingRetune.mode);
            setRequestedMood(pendingRetune.mood);
            setRequestedLanguage(pendingRetune.language);
        }, RETUNE_REQUEST_DEBOUNCE_MS);
        return () => window.clearTimeout(timeout);
    }, [pendingRetune]);
    const tracks = useMemo(
        () => selectWaveTracks(data?.shelves, requestedMode),
        [data?.shelves, requestedMode],
    );
    const queue = useMemo(() => tracks.map(toProviderPlaybackTrack), [tracks]);
    const handoffStartWarmup = useWaveStartWarmup(
        tracks[0]?.youtubeVideoId ?? null,
        Boolean(ownerId) &&
            !isPlaying &&
            !vibeMode &&
            !isLoading &&
            !isError &&
            !isListenTogetherActiveOrPending(),
    );

    useEffect(() => {
        if (!pendingRetune) return;
        if (!vibeMode) {
            setPendingRetune(null);
            return;
        }
        if (
            pendingRetune.generation !== retuneGenerationRef.current ||
            pendingRetune.mode !== requestedMode ||
            pendingRetune.mood !== requestedMood ||
            pendingRetune.language !== requestedLanguage ||
            isLoading
        ) {
            return;
        }

        // Listen Together owns a separate server-authoritative queue. Do not
        // turn a personal Wave retune into an accidental group queue append;
        // keep the saved selection for the next standalone Wave launch.
        if (isListenTogetherActiveOrPending()) {
            setPendingRetune(null);
            queueMicrotask(() => setRetuneNotice("saved"));
            return;
        }

        if (isError || queue.length === 0) {
            queueMicrotask(() => setRetuneNotice("kept"));
            return;
        }

        const currentTrackId = currentTrack?.id ?? null;
        const retunedQueue = currentTrackId
            ? queue.filter((track) => track.id !== currentTrackId)
            : queue;

        if (retunedQueue.length === 0) {
            queueMicrotask(() => setRetuneNotice("kept"));
            return;
        }

        setPendingRetune(null);
        // Applying a changed direction is an explicit request to leave the
        // current selection. Replace the whole ordered Wave queue and start
        // its first newly ranked track; filtering the audible identity avoids
        // immediately replaying the same song when it appears in both feeds.
        setIsShuffle(false);
        setShuffleIndices([]);
        playTracks(retunedQueue, 0, true);
        setVibeMode(true);
        setVibeSourceFeatures(null);
        setVibeQueueIds(retunedQueue.map((track) => track.id));
        setWaveMode(pendingRetune.mode);
        setWaveMood(pendingRetune.mood);
        setWaveLanguage(pendingRetune.language);
        queueMicrotask(() => setRetuneNotice("updated"));
    }, [
        currentTrack?.id,
        isError,
        isLoading,
        playTracks,
        pendingRetune,
        queue,
        requestedMode,
        requestedMood,
        requestedLanguage,
        setIsShuffle,
        setShuffleIndices,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
        setWaveMode,
        setWaveMood,
        setWaveLanguage,
        vibeMode,
    ]);
    useEffect(() => {
        if (!retuneNotice) return;
        // A failed active-Wave retune remains actionable until the user
        // retries or chooses another direction. Auto-dismiss only transient
        // success/save confirmations, never the sole recovery control.
        if (retuneNotice === "kept" && pendingRetune) return;
        const timeout = window.setTimeout(() => setRetuneNotice(null), 3200);
        return () => window.clearTimeout(timeout);
    }, [pendingRetune, retuneNotice]);
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
        setPendingRetune(null);
        setRetuneNotice(null);
        if (isListenTogetherActiveOrPending()) {
            setRetuneNotice("saved");
            return;
        }
        setWaveMode(activeMode);
        setWaveMood(activeMood);
        setWaveLanguage(activeLanguage);
        setIsShuffle(false);
        setShuffleIndices([]);
        handoffStartWarmup();
        playTracks(queue, 0, true);
        setVibeMode(true);
        setVibeSourceFeatures(null);
        setVibeQueueIds(queue.map((track) => track.id));
    }, [
        handoffStartWarmup,
        playTracks,
        queue,
        activeMode,
        activeMood,
        activeLanguage,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
        setIsShuffle,
        setShuffleIndices,
        setWaveMode,
        setWaveMood,
        setWaveLanguage,
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
        (
            mode: WaveFeedMode,
            mood: WaveMood | null,
            language: PersonalizedHomeLanguage,
        ) => {
            const shouldRetune =
                vibeMode &&
                (mode !== waveMode ||
                    mood !== waveMood ||
                    language !== waveLanguage);
            const shouldRefetchPending =
                shouldRetune &&
                pendingRetune?.mode === mode &&
                pendingRetune.mood === mood &&
                pendingRetune.language === language;
            if (shouldRetune) {
                retuneGenerationRef.current += 1;
                setPendingRetune({
                    mode,
                    mood,
                    language,
                    generation: retuneGenerationRef.current,
                });
            } else {
                setPendingRetune(null);
                setRequestedMode(mode);
                setRequestedMood(mood);
                setRequestedLanguage(language);
            }
            if (shouldRetune) setRetuneNotice(null);
            else if (!vibeMode) setRetuneNotice("saved");
            else setRetuneNotice(null);
            setActiveMode(mode);
            setActiveMood(mood);
            setActiveLanguage(language);
            if (!vibeMode) {
                setWaveMode(mode);
                setWaveMood(mood);
                setWaveLanguage(language);
            }
            persistWaveSelection(ownerId, mode, mood, language);
            replaceWaveSelection(mode, mood, language);
            setIsTuneOpen(false);
            queueMicrotask(() => tuneButtonRef.current?.focus());
            if (shouldRefetchPending) void refetch();
        },
        [
            ownerId,
            pendingRetune,
            refetch,
            setWaveMode,
            setWaveMood,
            setWaveLanguage,
            vibeMode,
            waveMode,
            waveMood,
            waveLanguage,
        ],
    );

    const retryRetune = useCallback(() => {
        setRetuneNotice(null);
        void refetch();
    }, [refetch]);

    return (
        <main
            data-wave-mode={activeMode}
            data-wave-language={activeLanguage}
            className={`relative h-full min-h-0 overflow-hidden bg-surface px-0 pt-0 ${currentTrack ? "pb-[calc(var(--app-mini-player-height)+var(--app-bottom-nav-height)+var(--safe-area-bottom)+4px)]" : "pb-[calc(var(--app-bottom-nav-height)+var(--safe-area-bottom))]"} sm:p-3 lg:p-5`}
        >
            <style>{`
                @media (prefers-reduced-transparency: reduce) {
                    .wave-material {
                        background-color: var(--color-surface-raised) !important;
                        -webkit-backdrop-filter: none !important;
                        backdrop-filter: none !important;
                    }
                }

                @media (max-width: 767px) and (max-height: 900px) {
                    .wave-density-core {
                        padding-top: 1rem !important;
                        padding-bottom: 0.75rem !important;
                    }

                    .wave-density-continuity,
                    .wave-density-subtitle {
                        display: none !important;
                    }

                    .wave-density-orbit {
                        width: 8rem !important;
                        height: 8rem !important;
                        margin-top: 0.75rem !important;
                    }

                    .wave-density-tuning,
                    .wave-density-notice,
                    .wave-density-empty {
                        margin-top: 0.75rem !important;
                    }

                    .wave-density-bottom {
                        padding-top: 0.625rem !important;
                        padding-bottom: 0.625rem !important;
                    }

                    .wave-density-bottom-grid {
                        gap: 0.5rem !important;
                    }

                    .wave-density-now {
                        padding: 0.625rem !important;
                    }

                    .wave-density-next-row:nth-child(n + 2) {
                        display: none !important;
                    }
                }

                @media (min-width: 1025px) and (max-height: 850px) {
                    .wave-density-core {
                        justify-content: center !important;
                        padding-top: 0.625rem !important;
                        padding-bottom: 0.625rem !important;
                    }

                    .wave-density-continuity,
                    .wave-density-subtitle {
                        display: none !important;
                    }

                    .wave-density-title {
                        margin-top: 0.2rem !important;
                        font-size: clamp(2.1rem, 5.2vh, 2.75rem) !important;
                    }

                    .wave-density-orbit {
                        width: 7.75rem !important;
                        height: 7.75rem !important;
                        margin-top: 0.4rem !important;
                    }

                    .wave-density-toggle {
                        width: 6.5rem !important;
                        height: 6.5rem !important;
                        min-width: 6.5rem !important;
                        min-height: 6.5rem !important;
                        padding-inline: 0.5rem !important;
                        font-size: 0.8rem !important;
                    }

                    .wave-density-toggle svg {
                        width: 1.5rem !important;
                        height: 1.5rem !important;
                    }

                    .wave-density-tuning,
                    .wave-density-notice,
                    .wave-density-empty {
                        margin-top: 0.5rem !important;
                    }

                    .wave-density-bottom {
                        padding-top: 0.5rem !important;
                        padding-bottom: 0.5rem !important;
                    }

                    .wave-density-now {
                        padding: 0.625rem !important;
                    }

                    .wave-density-next-row {
                        padding-top: 0.2rem !important;
                        padding-bottom: 0.2rem !important;
                    }
                }
            `}</style>
            <section
                data-testid="wave-surface"
                aria-labelledby="wave-title"
                className="relative isolate mx-auto flex h-full min-h-0 max-w-[96rem] flex-col overflow-hidden bg-surface-raised shadow-2xl shadow-black/35 sm:rounded-[2rem] sm:border sm:border-white/10"
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
                    <VibeAmbientMotion
                        trackId={
                            currentTrack?.id ??
                            nextTracks[0]?.id ??
                            `${activeMode}:${activeMood ?? "any"}`
                        }
                        bpm={currentTrack?.audioFeatures?.bpm}
                        energy={currentTrack?.audioFeatures?.energy}
                        mode={activeMode}
                        mood={activeMood}
                        isPlaying={hasActiveWave && isPlaying}
                    />
                    <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/15 to-black/60" />
                    <div className="absolute inset-0 bg-[linear-gradient(115deg,transparent_15%,rgb(255_255_255/0.035)_48%,transparent_72%)]" />
                </div>

                <div className="wave-density-core relative flex min-h-0 flex-1 flex-col items-center justify-start px-5 pb-8 pt-7 text-center sm:px-10 sm:pb-10 sm:pt-9 lg:px-16">
                    <div
                        data-testid="wave-continuity-status"
                        className="wave-density-continuity wave-material mb-4 inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3.5 py-2 text-xs font-semibold tracking-wide text-content-body backdrop-blur-xl"
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
                            className="wave-density-title mt-2 text-4xl font-black leading-[0.94] tracking-[-0.055em] text-white sm:text-5xl lg:text-6xl"
                        >
                            {ru.vibe.title}
                        </h1>
                        <p
                            data-testid="wave-description"
                            className="wave-density-subtitle mx-auto mt-3 line-clamp-2 max-w-xl text-sm leading-6 text-content-secondary sm:text-base"
                        >
                            {ru.vibe.subtitle}
                        </p>
                    </header>

                    <div
                        data-testid="wave-orbit-stage"
                        className="wave-density-orbit relative mt-6 grid h-40 w-40 place-items-center sm:h-44 sm:w-44"
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
                            aria-label={
                                !hasActiveWave && isLoading
                                    ? ru.vibe.tuning
                                    : primaryControlLabel
                            }
                            aria-busy={!hasActiveWave && isLoading}
                            aria-pressed={hasActiveWave && isPlaying}
                            className={`wave-density-toggle group relative z-10 flex h-28 min-h-20 w-28 min-w-20 flex-col items-center justify-center gap-1.5 rounded-full bg-white px-4 text-center text-sm font-black text-black shadow-2xl shadow-black/40 transition-[transform,background-color,box-shadow] duration-200 ease-out hover:scale-[1.035] hover:bg-brand-light hover:shadow-brand/20 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-transparent disabled:scale-100 motion-reduce:transition-none sm:h-32 sm:w-32 sm:text-base ${!hasActiveWave && isLoading ? "disabled:bg-white/85 disabled:text-black" : "disabled:bg-white/20 disabled:text-content-secondary"}`}
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
                            <span
                                data-testid="wave-main-label"
                                className="max-w-full whitespace-nowrap leading-[1.05]"
                            >
                                {!hasActiveWave && isLoading
                                    ? "Загрузка…"
                                    : hasActiveWave && isPlaying
                                      ? "Пауза"
                                      : "Слушать"}
                            </span>
                        </button>
                        {!hasActiveWave && isLoading && (
                            <span
                                data-testid="wave-loading-status"
                                role="status"
                                className="sr-only"
                            >
                                {ru.vibe.tuning}
                            </span>
                        )}
                    </div>

                    <div
                        data-testid="wave-current-tuning"
                        className="wave-density-tuning mt-5 flex w-full max-w-2xl flex-wrap items-center justify-center gap-2"
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
                            {activeLanguage !== "any" && (
                                <span>
                                    ·{" "}
                                    {
                                        WAVE_LANGUAGES.find(
                                            (item) =>
                                                item.id === activeLanguage,
                                        )?.label
                                    }
                                </span>
                            )}
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
                        <div
                            role="status"
                            aria-live="polite"
                            className={`wave-density-notice wave-material mt-3 flex flex-wrap items-center justify-center gap-2 rounded-2xl border px-4 py-2 text-sm font-semibold backdrop-blur-xl ${retuneNotice === "updated" || retuneNotice === "saved" ? "border-success/30 bg-success/10 text-success" : "border-warning/30 bg-warning/10 text-warning"}`}
                        >
                            <span>
                                {retuneNotice === "saved"
                                    ? "Настройка сохранена — она применится при следующем запуске."
                                    : retuneNotice === "updated"
                                      ? ru.vibe.updated
                                      : ru.vibe.updateFailed}
                            </span>
                            {retuneNotice === "kept" && pendingRetune && (
                                <button
                                    type="button"
                                    onClick={retryRetune}
                                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-current/25 px-4 py-2 text-sm font-bold transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current motion-reduce:transition-none"
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

                    {!isLoading && tracks.length === 0 && (
                        <div
                            className="wave-density-empty wave-material mt-7 max-w-lg rounded-2xl border border-white/10 bg-black/35 px-5 py-4 text-sm leading-6 text-content-secondary backdrop-blur-xl"
                            role={isError ? "alert" : "status"}
                        >
                            <p>
                                {isError
                                    ? ru.vibe.loadFailed
                                    : requestedLanguage !== "any"
                                      ? data?.languageStatus?.pending
                                          ? "Определяем язык подходящих вам треков. Повторите чуть позже или выберите «Любое»."
                                          : "Пока нет подходящих треков с этим языком. Попробуйте «Любое»."
                                      : requestedMood
                                        ? "Пока мало подходящих треков для этого настроения. Попробуйте «На своей волне» или вернитесь позже."
                                        : ru.vibe.empty}
                            </p>
                            {(isError || requestedLanguage !== "any") && (
                                <button
                                    type="button"
                                    onClick={
                                        pendingRetune
                                            ? retryRetune
                                            : () => void refetch()
                                    }
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
            </section>

            {isTuneOpen && (
                <WaveDirectionSheet
                    activeMode={activeMode}
                    activeMood={activeMood}
                    activeLanguage={activeLanguage}
                    isWaveActive={vibeMode}
                    isRetunePending={Boolean(pendingRetune)}
                    onApply={applyDirection}
                    onClose={closeTune}
                />
            )}
        </main>
    );
}
