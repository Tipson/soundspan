"use client";

import { Heart, ThumbsDown } from "lucide-react";
import { type TrackPreferenceSignal } from "@/lib/api";
import {
    useTrackPreference,
    type TrackPreferenceMetadata,
} from "@/hooks/useTrackPreference";
import { cn } from "@/utils/cn";

interface TrackPreferenceButtonsProps {
    trackId?: string | null;
    className?: string;
    buttonSizeClassName?: string;
    iconSizeClassName?: string;
    mode?: "both" | "up-only" | "down-only";
    signal?: TrackPreferenceSignal;
    isSaving?: boolean;
    onToggleThumbsUp?: () => Promise<unknown> | unknown;
    onToggleThumbsDown?: () => Promise<unknown> | unknown;
    onThumbsDownApplied?: (trackId: string) => void;
    resolveFromQuery?: boolean;
    metadata?: TrackPreferenceMetadata;
}

function isConfirmedThumbsDown(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        "signal" in value &&
        value.signal === "thumbs_down"
    );
}

interface TrackPreferenceButtonsContentProps {
    className?: string;
    buttonSizeClassName: string;
    iconSizeClassName: string;
    preferenceSignal: TrackPreferenceSignal;
    isPreferenceSaving: boolean;
    mode: "both" | "up-only" | "down-only";
    canToggleLike: boolean;
    canToggleDislike: boolean;
    onLikeToggle: () => Promise<unknown> | unknown;
    onDislikeToggle: () => Promise<unknown> | unknown;
}

const noopPreferenceToggle = () => undefined;

function TrackPreferenceButtonsContent({
    className,
    buttonSizeClassName,
    iconSizeClassName,
    preferenceSignal,
    isPreferenceSaving,
    mode,
    canToggleLike,
    canToggleDislike,
    onLikeToggle,
    onDislikeToggle,
}: TrackPreferenceButtonsContentProps) {
    const isLiked = preferenceSignal === "thumbs_up";
    const isDisliked = preferenceSignal === "thumbs_down";
    const likeLabel = isLiked ? "Убрать отметку «Нравится»" : "Нравится";
    const dislikeLabel = isDisliked
        ? "Убрать отметку «Не нравится»"
        : "Не нравится";
    const showLike = mode !== "down-only";
    const showDislike = mode !== "up-only";

    const baseButtonClass = cn(
        "inline-flex items-center justify-center rounded-xl bg-transparent p-0 transition-[color,background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-40 enabled:active:scale-95",
        buttonSizeClassName,
    );

    return (
        <div
            className={cn("flex items-center gap-1", className)}
            role="group"
            aria-label="Оценка трека"
        >
            {showLike && (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        void onLikeToggle();
                    }}
                    className={cn(
                        baseButtonClass,
                        isLiked
                            ? "bg-success/10 text-success"
                            : "text-content-muted hover:bg-surface-hover hover:text-content",
                    )}
                    disabled={!canToggleLike || isPreferenceSaving}
                    aria-label={likeLabel}
                    aria-pressed={isLiked}
                    title={likeLabel}
                >
                    {isLiked ? (
                        <Heart
                            className={iconSizeClassName}
                            fill="currentColor"
                            data-icon="heart-filled"
                        />
                    ) : (
                        <Heart
                            className={iconSizeClassName}
                            data-icon="heart-outline"
                        />
                    )}
                </button>
            )}
            {showDislike && (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        void onDislikeToggle();
                    }}
                    className={cn(
                        baseButtonClass,
                        isDisliked
                            ? "bg-error/10 text-error"
                            : "text-content-muted hover:bg-surface-hover hover:text-content",
                    )}
                    disabled={!canToggleDislike || isPreferenceSaving}
                    aria-label={dislikeLabel}
                    aria-pressed={isDisliked}
                    title={dislikeLabel}
                >
                    <ThumbsDown
                        className={iconSizeClassName}
                        fill={isDisliked ? "currentColor" : "none"}
                        data-icon={
                            isDisliked
                                ? "thumbs-down-filled"
                                : "thumbs-down-outline"
                        }
                    />
                </button>
            )}
        </div>
    );
}

function TrackPreferenceButtonsControlled({
    trackId,
    className,
    buttonSizeClassName,
    iconSizeClassName,
    signal,
    isSaving,
    onToggleThumbsUp,
    onToggleThumbsDown,
    onThumbsDownApplied,
    mode = "up-only",
}: TrackPreferenceButtonsProps) {
    const canToggleLike = Boolean(onToggleThumbsUp);
    const canToggleDislike = Boolean(onToggleThumbsDown);
    const handleDislikeToggle = async () => {
        const result = await (onToggleThumbsDown ?? noopPreferenceToggle)();
        if (trackId && onThumbsDownApplied && isConfirmedThumbsDown(result)) {
            onThumbsDownApplied(trackId);
        }
        return result;
    };

    return (
        <TrackPreferenceButtonsContent
            className={className}
            buttonSizeClassName={buttonSizeClassName ?? "h-11 w-11"}
            iconSizeClassName={iconSizeClassName ?? "h-6 w-6"}
            preferenceSignal={signal ?? "clear"}
            isPreferenceSaving={isSaving ?? false}
            mode={mode}
            canToggleLike={canToggleLike}
            canToggleDislike={canToggleDislike}
            onLikeToggle={onToggleThumbsUp ?? noopPreferenceToggle}
            onDislikeToggle={handleDislikeToggle}
        />
    );
}

function TrackPreferenceButtonsWithQuery({
    trackId,
    className,
    buttonSizeClassName,
    iconSizeClassName,
    signal,
    isSaving,
    onToggleThumbsUp,
    onToggleThumbsDown,
    onThumbsDownApplied,
    mode = "up-only",
    metadata,
}: TrackPreferenceButtonsProps) {
    const {
        signal: queriedSignal,
        isSaving: queriedIsSaving,
        toggleLike: queriedToggleLike,
        toggleDislike: queriedToggleDislike,
    } = useTrackPreference(trackId, metadata);

    const preferenceSignal = signal ?? queriedSignal;
    const isPreferenceSaving = isSaving ?? queriedIsSaving;
    const canToggleLike = Boolean(trackId) || Boolean(onToggleThumbsUp);
    const canToggleDislike = Boolean(trackId) || Boolean(onToggleThumbsDown);
    const handleDislikeToggle = async () => {
        const result = await (onToggleThumbsDown ?? queriedToggleDislike)();
        if (trackId && onThumbsDownApplied && isConfirmedThumbsDown(result)) {
            onThumbsDownApplied(trackId);
        }
        return result;
    };

    return (
        <TrackPreferenceButtonsContent
            className={className}
            buttonSizeClassName={buttonSizeClassName ?? "h-11 w-11"}
            iconSizeClassName={iconSizeClassName ?? "h-6 w-6"}
            preferenceSignal={preferenceSignal}
            isPreferenceSaving={isPreferenceSaving}
            mode={mode}
            canToggleLike={canToggleLike}
            canToggleDislike={canToggleDislike}
            onLikeToggle={onToggleThumbsUp ?? queriedToggleLike}
            onDislikeToggle={handleDislikeToggle}
        />
    );
}

/**
 * Renders the TrackPreferenceButtons component.
 */
export function TrackPreferenceButtons(props: TrackPreferenceButtonsProps) {
    if (props.resolveFromQuery === false) {
        return <TrackPreferenceButtonsControlled {...props} />;
    }
    return <TrackPreferenceButtonsWithQuery {...props} />;
}
