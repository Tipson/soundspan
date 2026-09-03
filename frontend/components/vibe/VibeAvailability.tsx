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
import { isListenTogetherActiveOrPending } from "@/lib/listen-together-session";
import { api } from "@/lib/api";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import { ru } from "@/lib/i18n/ru";
import { NowPlayingConnected } from "./NowPlayingConnected";
import { VibeAmbientMotion } from "./VibeAmbientMotion";
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
        generation: number;
    } | null>(null);
    const { advanceQueue, pause, play, playTracks } = useAudioControls();
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
        requestedMode,
        requestedMood,
        "wave",
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
                (selection.mode !== waveMode || selection.mood !== waveMood);
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
            }
            setActiveMode(selection.mode);
            setActiveMood(selection.mood);
            if (!shouldRetuneActiveWave) {
                setWaveMode(selection.mode);
                setWaveMood(selection.mood);
            }
        });
        return () => {
            mounted = false;
        };
    }, [ownerId, setWaveMode, setWaveMood, vibeMode, waveMode, waveMood]);
    useEffect(() => {
        if (!pendingRetune) return;
        const generation = pendingRetune.generation;
        const timeout = window.setTimeout(() => {
            if (retuneGenerationRef.current !== generation) return;
            setRequestedMode(pendingRetune.mode);
            setRequestedMood(pendingRetune.mood);
        }, RETUNE_REQUEST_DEBOUNCE_MS);
        return () => window.clearTimeout(timeout);
    }, [pendingRetune]);
    const tracks = useMemo(
        () => selectWaveTracks(data?.shelves, requestedMode),
        [data?.shelves, requestedMode],
    );
    const queue = useMemo(() => tracks.map(toProviderPlaybackTrack), [tracks]);

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
        setIsShuffle,
        setShuffleIndices,
        setVibeMode,
        setVibeQueueIds,
        setVibeSourceFeatures,
        setWaveMode,
        setWaveMood,
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
                vibeMode && (mode !== waveMode || mood !== waveMood);
            const shouldRefetchPending =
                shouldRetune &&
                pendingRetune?.mode === mode &&
                pendingRetune.mood === mood;
            if (shouldRetune) {
                retuneGenerationRef.current += 1;
                setPendingRetune({
                    mode,
                    mood,
                    generation: retuneGenerationRef.current,
                });
            } else {
                setPendingRetune(null);
                setRequestedMode(mode);
                setRequestedMood(mood);
            }
            if (shouldRetune) setRetuneNotice(null);
            else if (!vibeMode) setRetuneNotice("saved");
            else setRetuneNotice(null);
            setActiveMode(mode);
            setActiveMood(mood);
            if (!vibeMode) {
                setWaveMode(mode);
                setWaveMood(mood);
            }
            persistWaveSelection(ownerId, mode, mood);
            replaceWaveSelection(mode, mood);
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
            vibeMode,
            waveMode,
            waveMood,
        ],
    );

    const retryRetune = useCallback(() => {
        setRetuneNotice(null);
        void refetch();
    }, [refetch]);

    return (
        <main
            data-wave-mode={activeMode}
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
                            aria-label={primaryControlLabel}
                            aria-pressed={hasActiveWave && isPlaying}
                            className="wave-density-toggle group relative z-10 flex h-28 min-h-20 w-28 min-w-20 flex-col items-center justify-center gap-1.5 rounded-full bg-white px-4 text-center text-sm font-black text-black shadow-2xl shadow-black/40 transition-[transform,background-color,box-shadow] duration-200 ease-out hover:scale-[1.035] hover:bg-brand-light hover:shadow-brand/20 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-4 focus-visible:ring-offset-transparent disabled:scale-100 disabled:bg-white/15 disabled:text-content-muted motion-reduce:transition-none sm:h-32 sm:w-32 sm:text-base"
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
                            <span className="max-w-full leading-[1.05] [text-wrap:balance]">
                                {!hasActiveWave && isLoading
                                    ? ru.vibe.tuning
                                    : primaryControlLabel}
                            </span>
                        </button>
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
                                {isError ? ru.vibe.loadFailed : ru.vibe.empty}
                            </p>
                            {isError && (
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

                {hasActiveWave && (currentTrack || nextTracks.length > 0) && (
                    <div className="wave-density-bottom wave-material relative hidden shrink-0 border-t border-white/10 bg-black/30 px-4 py-4 backdrop-blur-2xl min-[900px]:block min-[1025px]:px-8">
                        <div className="wave-density-bottom-grid mx-auto grid max-w-6xl gap-4 min-[900px]:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.75fr)] min-[900px]:items-center">
                            {currentTrack ? (
                                <section
                                    data-testid="wave-now-playing-panel"
                                    aria-labelledby="wave-now-playing-title"
                                    className="wave-density-now min-w-0 rounded-2xl bg-white/[0.045] p-3 sm:p-4"
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
                                                data-testid="wave-skip"
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
                                                    className="wave-density-next-row flex min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
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
                    isRetunePending={Boolean(pendingRetune)}
                    onApply={applyDirection}
                    onClose={closeTune}
                />
            )}
        </main>
    );
}
