"use client";

import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AudioWaveform, Check, X } from "lucide-react";

/** Provider-backed ranking directions currently supported by My Wave. */
export type WaveFeedMode = "for-you" | "new" | "familiar";

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
        label: "For you",
        shortLabel: "Your mix",
        subtitle:
            "Favorites, recent listens, and new finds in one balanced flow.",
    },
    {
        id: "new",
        label: "New to me",
        shortLabel: "Open up",
        subtitle:
            "Lean further into artists and tracks outside your usual rotation.",
    },
    {
        id: "familiar",
        label: "Familiar",
        shortLabel: "Stay close",
        subtitle:
            "Stay near music you return to and quick picks you already know.",
    },
];

interface WaveDirectionSheetProps {
    activeMode: WaveFeedMode;
    onApply: (mode: WaveFeedMode) => void;
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
    onApply,
    onClose,
}: WaveDirectionSheetProps) {
    const [draftMode, setDraftMode] = useState(activeMode);
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

    return (
        <div
            className="fixed inset-0 z-[10010] flex items-end justify-center bg-black/80 px-0 backdrop-blur-md sm:items-center sm:px-5"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
            role="presentation"
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="wave-direction-title"
                aria-describedby="wave-direction-description"
                className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[2rem] border border-white/10 bg-surface-raised px-5 pb-[max(1.25rem,var(--safe-area-bottom))] pt-5 shadow-2xl shadow-black/60 sm:max-w-3xl sm:rounded-[2rem] sm:p-7"
            >
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-light">
                            What should come next?
                        </p>
                        <h2
                            id="wave-direction-title"
                            className="mt-2 text-2xl font-black tracking-[-0.035em] text-content sm:text-3xl"
                        >
                            Tune My Wave
                        </h2>
                        <p
                            id="wave-direction-description"
                            className="mt-2 max-w-md text-sm leading-6 text-content-secondary"
                        >
                            Choose how close the next picks stay to your
                            listening history. Your current song keeps playing
                            while the Wave changes course.
                        </p>
                    </div>
                    <button
                        ref={closeButtonRef}
                        type="button"
                        onClick={onClose}
                        aria-label="Close Tune My Wave"
                        className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full border border-white/10 bg-black/25 text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                    >
                        <X className="h-5 w-5" aria-hidden="true" />
                    </button>
                </div>

                <div
                    role="radiogroup"
                    aria-label="My Wave direction"
                    tabIndex={-1}
                    onKeyDown={handleRadioKeyDown}
                    className="mt-6 grid gap-3 sm:grid-cols-3"
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
                                className={`group flex min-h-[7.5rem] w-full items-center gap-4 rounded-2xl border px-4 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:min-h-[12rem] sm:flex-col sm:items-start ${
                                    selected
                                        ? "border-brand/50 bg-brand/12"
                                        : "border-white/8 bg-black/20 hover:border-white/15 hover:bg-white/[0.055]"
                                }`}
                            >
                                <span
                                    className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors motion-reduce:transition-none ${
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
                                    <span className="block text-[0.65rem] font-bold uppercase tracking-[0.14em] text-brand-light">
                                        {mode.shortLabel}
                                    </span>
                                    <span className="mt-1 block text-base font-bold text-content">
                                        {mode.label}
                                    </span>
                                    <span className="mt-1 block text-xs leading-5 text-content-muted sm:text-sm">
                                        {mode.subtitle}
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </div>

                <div className="mt-6 grid gap-4 border-t border-white/8 pt-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <p className="text-sm text-content-secondary">
                        Selected: {selectedDefinition.shortLabel}. You can tune
                        again at any time.
                    </p>
                    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <button
                            type="button"
                            onClick={onClose}
                            className="inline-flex min-h-11 items-center justify-center rounded-full px-5 py-2 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => onApply(draftMode)}
                            className="inline-flex min-h-11 items-center justify-center rounded-full bg-brand px-5 py-2 text-sm font-black text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised motion-reduce:transition-none"
                        >
                            Use {selectedDefinition.label}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
