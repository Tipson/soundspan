"use client";

import { ExternalLink, Trash2, Plus, Loader2 } from "lucide-react";
import type { ColorPalette } from "@/hooks/useImageColor";
import { podcastRu } from "@/lib/i18n/podcastRu";

interface PodcastActionBarProps {
    isSubscribed: boolean;
    feedUrl?: string;
    colors: ColorPalette | null;
    isSubscribing: boolean;
    showDeleteConfirm: boolean;
    onSubscribe: () => void;
    onRemove: () => void;
    onShowDeleteConfirm: (show: boolean) => void;
}

/**
 * Renders the PodcastActionBar component.
 */
export function PodcastActionBar({
    isSubscribed,
    feedUrl,
    isSubscribing,
    showDeleteConfirm,
    onSubscribe,
    onRemove,
    onShowDeleteConfirm,
}: PodcastActionBarProps) {
    return (
        <div className="flex min-h-14 flex-wrap items-center gap-3">
            {/* Primary subscription action */}
            {!isSubscribed && (
                <button
                    onClick={onSubscribe}
                    disabled={isSubscribing}
                    className="flex min-h-12 items-center gap-2 rounded-[10px] bg-brand px-5 font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:opacity-50 motion-reduce:transition-none"
                >
                    {isSubscribing ? (
                        <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span>{podcastRu.detail.subscribing}</span>
                        </>
                    ) : (
                        <>
                            <Plus className="w-5 h-5" />
                            <span>{podcastRu.detail.subscribe}</span>
                        </>
                    )}
                </button>
            )}

            {/* RSS Feed Link */}
            {feedUrl && (
                <a
                    href={feedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-11 w-11 items-center justify-center rounded-[10px] text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                    title={podcastRu.detail.rssFeed}
                >
                    <ExternalLink className="w-5 h-5" />
                </a>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Remove Podcast Button */}
            {isSubscribed && (
                <>
                    {!showDeleteConfirm ? (
                        <button
                            onClick={() => onShowDeleteConfirm(true)}
                            aria-label={`${podcastRu.detail.remove} ${podcastRu.detail.type.toLowerCase()}`}
                            className="flex min-h-11 items-center gap-2 rounded-[10px] px-3 py-2 text-sm text-error transition-colors hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                        >
                            <Trash2 className="w-4 h-4" />
                            <span className="hidden md:inline">
                                {podcastRu.detail.remove}
                            </span>
                        </button>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="hidden text-sm text-content-secondary md:inline">
                                {podcastRu.detail.removeQuestion}
                            </span>
                            <button
                                onClick={onRemove}
                                className="min-h-11 rounded-[10px] bg-error/15 px-4 py-2 text-sm font-medium text-error transition-colors hover:bg-error/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                            >
                                {podcastRu.detail.confirm}
                            </button>
                            <button
                                onClick={() => onShowDeleteConfirm(false)}
                                className="min-h-11 rounded-[10px] bg-surface-raised px-4 py-2 text-sm font-medium text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                            >
                                {podcastRu.detail.cancel}
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
