"use client";

import { Play, Pause, RotateCcw, CheckCircle, Loader2 } from "lucide-react";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { formatTime as defaultFormatTime } from "@/utils/formatTime";
import type { Audiobook } from "../types";

interface AudiobookActionBarProps {
    audiobook: Audiobook;
    isThisBookPlaying?: boolean;
    isPlaying?: boolean;
    currentTime?: number;
    onPlayPause?: () => void;
    onResetProgress: () => void;
    onMarkAsCompleted: () => void;
    formatTime?: (seconds: number) => string;
}

/**
 * Renders the AudiobookActionBar component.
 */
export function AudiobookActionBar({
    audiobook,
    isThisBookPlaying = false,
    isPlaying = false,
    currentTime = 0,
    onPlayPause,
    onResetProgress,
    onMarkAsCompleted,
    formatTime = defaultFormatTime,
}: AudiobookActionBarProps) {
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();
    const progress = audiobook.progress;
    const hasProgress = (progress?.progress ?? 0) > 0;
    const isFinished = progress?.isFinished;
    const showingPause = isThisBookPlaying && isPlaying;
    const handlePlayPauseClick = () => {
        if (!onPlayPause) return;
        triggerPlayFeedback();
        onPlayPause();
    };

    return (
        <div className="flex min-h-14 flex-wrap items-center gap-3">
            {/* Primary playback action */}
            {onPlayPause && (
                <button
                    onClick={handlePlayPauseClick}
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand text-surface shadow-[0_8px_24px_rgb(0_0_0/0.2)] transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface motion-reduce:transition-none"
                    title={
                        showingPause
                            ? "Пауза"
                            : hasProgress && !isFinished
                              ? "Продолжить"
                              : "Слушать"
                    }
                >
                    {showSpinner ? (
                        <Loader2 className="h-6 w-6 animate-spin" />
                    ) : showingPause ? (
                        <Pause className="h-6 w-6" />
                    ) : (
                        <Play className="ml-1 h-6 w-6" fill="currentColor" />
                    )}
                </button>
            )}

            {/* Progress indicator - compact inline */}
            {hasProgress && !isFinished && (
                <div className="hidden sm:flex items-center gap-3">
                    <div className="text-sm">
                        <span className="text-content-secondary">
                            {formatTime(
                                isThisBookPlaying
                                    ? currentTime
                                    : (progress?.currentTime ?? 0),
                            )}
                        </span>
                        <span className="mx-1 text-content-muted">/</span>
                        <span className="text-content-secondary">
                            {formatTime(audiobook.duration)}
                        </span>
                    </div>
                    <div className="h-1 w-24 overflow-hidden rounded-full bg-surface-highlight">
                        <div
                            className="h-full bg-brand rounded-full transition-all"
                            style={{
                                width: `${isThisBookPlaying ? (currentTime / audiobook.duration) * 100 : (progress?.progress ?? 0)}%`,
                            }}
                        />
                    </div>
                </div>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Action buttons - right side */}
            <div className="flex items-center gap-2">
                {hasProgress && !isFinished && (
                    <>
                        <button
                            onClick={onResetProgress}
                            className="flex h-11 w-11 items-center justify-center rounded-[10px] text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                            title="Сбросить прогресс"
                        >
                            <RotateCcw className="w-5 h-5" />
                        </button>
                        <button
                            onClick={onMarkAsCompleted}
                            className="flex h-11 w-11 items-center justify-center rounded-[10px] text-success transition-colors hover:bg-success/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                            title="Отметить как прослушанную"
                        >
                            <CheckCircle className="w-5 h-5" />
                        </button>
                    </>
                )}

                {isFinished && (
                    <button
                        onClick={onResetProgress}
                        className="flex min-h-11 items-center gap-2 rounded-[10px] bg-surface-raised px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                        title="Слушать снова"
                    >
                        <RotateCcw className="w-4 h-4" />
                        <span>Слушать снова</span>
                    </button>
                )}
            </div>
        </div>
    );
}
