"use client";

import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AudioWaveform, Check, X } from "lucide-react";
import type { PersonalizedHomeMood } from "@/features/home/types";
import { ru } from "@/lib/i18n/ru";

/** Provider-backed ranking directions currently supported by My Wave. */
export type WaveFeedMode = "for-you" | "new" | "familiar";
export type WaveMood = PersonalizedHomeMood;

/** User-facing metadata for one supported My Wave direction. */
export interface WaveModeDefinition {
    id: WaveFeedMode;
    label: string;
    shortLabel: string;
    subtitle: string;
}

/** The complete set of directions backed by the personalized provider feed. */
export const WAVE_MODES: readonly WaveModeDefinition[] = [
    {
        id: "for-you",
        ...ru.vibe.modes.forYou,
    },
    {
        id: "new",
        ...ru.vibe.modes.new,
    },
    {
        id: "familiar",
        ...ru.vibe.modes.familiar,
    },
];

/** User-facing listening contexts applied independently from Wave direction. */
export const WAVE_MOODS: readonly {
    id: WaveMood | null;
    label: string;
    subtitle: string;
}[] = [
    {
        id: null,
        label: ru.vibe.moods.any[0],
        subtitle: ru.vibe.moods.any[1],
    },
    {
        id: "calm",
        label: ru.vibe.moods.calm[0],
        subtitle: ru.vibe.moods.calm[1],
    },
    {
        id: "energetic",
        label: ru.vibe.moods.energetic[0],
        subtitle: ru.vibe.moods.energetic[1],
    },
    {
        id: "focus",
        label: ru.vibe.moods.focus[0],
        subtitle: ru.vibe.moods.focus[1],
    },
    {
        id: "workout",
        label: ru.vibe.moods.workout[0],
        subtitle: ru.vibe.moods.workout[1],
    },
    {
        id: "favorites",
        label: ru.vibe.moods.favorites[0],
        subtitle: ru.vibe.moods.favorites[1],
    },
    {
        id: "forgotten",
        label: ru.vibe.moods.forgotten[0],
        subtitle: ru.vibe.moods.forgotten[1],
    },
];

interface WaveDirectionSheetProps {
    activeMode: WaveFeedMode;
    activeMood: WaveMood | null;
    onApply: (mode: WaveFeedMode, mood: WaveMood | null) => void;
    onClose: () => void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(
        container.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
    );
}

function nextRadioIndex(
    key: string,
    currentIndex: number,
    optionCount: number,
): number | null {
    if (key === "Home") return 0;
    if (key === "End") return optionCount - 1;
    if (key === "ArrowDown" || key === "ArrowRight") {
        return (currentIndex + 1) % optionCount;
    }
    if (key === "ArrowUp" || key === "ArrowLeft") {
        return (currentIndex - 1 + optionCount) % optionCount;
    }
    return null;
}

/** Accessible mobile sheet / desktop dialog for choosing a supported Wave direction. */
export function WaveDirectionSheet({
    activeMode,
    activeMood,
    onApply,
    onClose,
}: WaveDirectionSheetProps) {
    const [draftMode, setDraftMode] = useState(activeMode);
    const [draftMood, setDraftMood] = useState<WaveMood | null>(activeMood);
    const dialogRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        closeButtonRef.current?.focus();

        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, []);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key !== "Tab" || !dialogRef.current) return;

            const focusable = focusableElements(dialogRef.current);
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);

    const selectedDefinition = useMemo(
        () => WAVE_MODES.find((mode) => mode.id === draftMode) ?? WAVE_MODES[0],
        [draftMode],
    );
    const selectedMoodDefinition = useMemo(
        () => WAVE_MOODS.find((mood) => mood.id === draftMood) ?? WAVE_MOODS[0],
        [draftMood],
    );
    const handleRadioKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        const currentIndex = WAVE_MODES.findIndex(
            (mode) => mode.id === draftMode,
        );
        const nextIndex = nextRadioIndex(
            event.key,
            Math.max(currentIndex, 0),
            WAVE_MODES.length,
        );
        if (nextIndex === null) return;

        event.preventDefault();
        const nextMode = WAVE_MODES[nextIndex];
        setDraftMode(nextMode.id);
        const options = event.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button[role="radio"]',
        );
        options[nextIndex]?.focus();
    };
    const handleMoodRadioKeyDown = (
        event: ReactKeyboardEvent<HTMLDivElement>,
    ) => {
        const currentIndex = WAVE_MOODS.findIndex(
            (mood) => mood.id === draftMood,
        );
        const nextIndex = nextRadioIndex(
            event.key,
            Math.max(currentIndex, 0),
            WAVE_MOODS.length,
        );
        if (nextIndex === null) return;

        event.preventDefault();
        setDraftMood(WAVE_MOODS[nextIndex].id);
        event.currentTarget
            .querySelectorAll<HTMLButtonElement>('button[role="radio"]')
            [nextIndex]?.focus();
    };

    return (
        <div
            className="fixed inset-0 z-[10010] flex items-end justify-center bg-black/65 px-0 backdrop-blur-sm sm:items-center sm:px-5"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
            role="presentation"
        >
            <div
                ref={dialogRef}
                data-testid="wave-tune-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="wave-direction-title"
                aria-describedby="wave-direction-description"
                className="wave-material max-h-[90dvh] w-full overflow-y-auto rounded-t-[2rem] border border-white/10 bg-surface-raised/95 px-5 pb-[max(1.25rem,var(--safe-area-bottom))] pt-5 shadow-2xl shadow-black/60 backdrop-blur-2xl sm:max-w-2xl sm:rounded-[2rem] sm:p-7"
            >
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-light">
                            {ru.vibe.tuneEyebrow}
                        </p>
                        <h2
                            id="wave-direction-title"
                            className="mt-2 text-2xl font-black tracking-[-0.035em] text-content sm:text-3xl"
                        >
                            {ru.vibe.tuneTitle}
                        </h2>
                        <p
                            id="wave-direction-description"
                            className="mt-2 max-w-md text-sm leading-6 text-content-secondary"
                        >
                            {ru.vibe.tuneDescription}
                        </p>
                    </div>
                    <button
                        ref={closeButtonRef}
                        type="button"
                        onClick={onClose}
                        aria-label={ru.vibe.closeTune}
                        className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full border border-white/10 bg-black/25 text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    >
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                </div>

                <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-content-muted">
                    {ru.vibe.direction}
                </p>
                <div
                    role="radiogroup"
                    aria-label={ru.vibe.directionAria}
                    tabIndex={-1}
                    onKeyDown={handleRadioKeyDown}
                    className="mt-3 grid gap-2 sm:grid-cols-3"
                >
                    {WAVE_MODES.map((mode) => {
                        const selected = mode.id === draftMode;
                        return (
                            <button
                                key={mode.id}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                aria-label={mode.label}
                                tabIndex={selected ? 0 : -1}
                                onClick={() => setDraftMode(mode.id)}
                                className={`group flex min-h-[5.5rem] w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-[transform,background-color,border-color] duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none ${
                                    selected
                                        ? "border-brand/50 bg-brand/12"
                                        : "border-white/8 bg-black/20 hover:border-white/15 hover:bg-white/[0.055]"
                                }`}
                            >
                                <span
                                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors motion-reduce:transition-none ${
                                        selected
                                            ? "bg-brand text-black"
                                            : "bg-white/[0.06] text-content-secondary group-hover:text-content"
                                    }`}
                                >
                                    {selected ? (
                                        <Check
                                            className="h-5 w-5"
                                            aria-hidden="true"
                                        />
                                    ) : (
                                        <AudioWaveform
                                            className="h-5 w-5"
                                            aria-hidden="true"
                                        />
                                    )}
                                </span>
                                <span className="min-w-0 flex-1 whitespace-normal break-words">
                                    <span className="block text-[0.62rem] font-bold uppercase tracking-[0.14em] text-brand-light">
                                        {mode.shortLabel}
                                    </span>
                                    <span className="mt-0.5 block text-sm font-bold text-content">
                                        {mode.label}
                                    </span>
                                    <span className="mt-0.5 block text-xs leading-4 text-content-muted">
                                        {mode.subtitle}
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </div>

                <div className="mt-6 border-t border-white/8 pt-5">
                    <div>
                        <p className="text-xs font-bold uppercase tracking-[0.16em] text-content-muted">
                            {ru.vibe.mood}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-content-secondary">
                            {ru.vibe.moodDescription}
                        </p>
                    </div>
                    <div
                        role="radiogroup"
                        aria-label={ru.vibe.moodAria}
                        tabIndex={-1}
                        onKeyDown={handleMoodRadioKeyDown}
                        className="mt-3 flex flex-wrap gap-2"
                    >
                        {WAVE_MOODS.map((mood) => {
                            const selected = mood.id === draftMood;
                            return (
                                <button
                                    key={mood.id ?? "any"}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    aria-label={mood.label}
                                    tabIndex={selected ? 0 : -1}
                                    onClick={() => setDraftMood(mood.id)}
                                    className={`group flex min-h-11 min-w-[9.5rem] flex-1 items-center gap-2.5 rounded-full border px-3.5 py-2.5 text-left transition-[transform,background-color,border-color] duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none ${
                                        selected
                                            ? "border-brand/50 bg-brand/12"
                                            : "border-white/8 bg-black/20 hover:border-white/15 hover:bg-white/[0.055]"
                                    }`}
                                >
                                    <span
                                        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${
                                            selected
                                                ? "bg-brand text-black"
                                                : "bg-white/[0.06] text-content-secondary"
                                        }`}
                                    >
                                        {selected ? (
                                            <Check
                                                className="h-4 w-4"
                                                aria-hidden="true"
                                            />
                                        ) : (
                                            <AudioWaveform
                                                className="h-4 w-4"
                                                aria-hidden="true"
                                            />
                                        )}
                                    </span>
                                    <span className="min-w-0">
                                        <span className="block text-sm font-bold text-content">
                                            {mood.label}
                                        </span>
                                        <span className="mt-0.5 hidden text-xs leading-4 text-content-muted min-[480px]:block">
                                            {mood.subtitle}
                                        </span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="mt-6 grid gap-4 border-t border-white/8 pt-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <p className="text-sm text-content-secondary">
                        {ru.vibe.selected}: {selectedDefinition.shortLabel} ·{" "}
                        {selectedMoodDefinition.label}. {ru.vibe.tuneAnytime}
                    </p>
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <button
                            type="button"
                            onClick={onClose}
                            className="inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            {ru.common.cancel}
                        </button>
                        <button
                            type="button"
                            onClick={() => onApply(draftMode, draftMood)}
                            className="inline-flex min-h-11 items-center justify-center rounded-full bg-brand px-5 py-2 text-sm font-black text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised motion-reduce:transition-none"
                        >
                            {ru.vibe.use}: {selectedDefinition.label}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
