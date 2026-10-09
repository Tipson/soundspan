"use client";

import { Loader2, Pause, Play } from "lucide-react";
import { ru } from "@/lib/i18n/ru";

interface CollectionPlaybackButtonProps {
    isPlaying?: boolean;
    isLoading?: boolean;
    disabled?: boolean;
    onClick: () => void;
    label?: string;
    title?: string;
}

/** Accessible icon-only primary playback control shared by music collections. */
export function CollectionPlaybackButton({
    isPlaying = false,
    isLoading = false,
    disabled = false,
    onClick,
    label,
    title,
}: CollectionPlaybackButtonProps) {
    const accessibleLabel =
        label ?? (isPlaying ? ru.common.pause : ru.common.playAll);
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={accessibleLabel}
            title={title ?? accessibleLabel}
            aria-busy={isLoading || undefined}
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand text-white shadow-lg transition-transform hover:scale-105 hover:bg-brand-hover active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
            {isLoading ? (
                <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
            ) : isPlaying ? (
                <Pause className="h-6 w-6 fill-current" aria-hidden="true" />
            ) : (
                <Play
                    className="ml-0.5 h-6 w-6 fill-current"
                    aria-hidden="true"
                />
            )}
        </button>
    );
}
