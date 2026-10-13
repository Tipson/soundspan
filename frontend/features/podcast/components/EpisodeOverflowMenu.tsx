"use client";

import React, { useCallback, useState } from "react";
import { EllipsisVertical, ListEnd, ListPlus } from "lucide-react";
import { cn } from "@/utils/cn";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Episode } from "../types";
import { podcastRu } from "@/lib/i18n/podcastRu";
import { Modal } from "@/components/ui/Modal";

interface EpisodeOverflowMenuProps {
    episode: Episode;
    podcast: { id: string; title: string; coverUrl: string | null };
    className?: string;
    triggerClassName?: string;
}

/**
 * Overflow menu for a podcast episode with mixed-media queue actions
 * ("Play next" / "Add to queue"), mirroring TrackOverflowMenu for tracks.
 */
export function EpisodeOverflowMenu({
    episode,
    podcast,
    className,
    triggerClassName,
}: EpisodeOverflowMenuProps) {
    const [isOpen, setIsOpen] = useState(false);
    const { addEpisodeToQueue, playEpisodeNext } = useAudioControls();

    const handleToggle = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setIsOpen((prev) => !prev);
    }, []);

    const handlePlayNext = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            playEpisodeNext(episode, podcast);
            setIsOpen(false);
        },
        [episode, podcast, playEpisodeNext],
    );

    const handleAddToQueue = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            addEpisodeToQueue(episode, podcast);
            setIsOpen(false);
        },
        [episode, podcast, addEpisodeToQueue],
    );

    return (
        <div
            className={cn(
                "relative flex items-center justify-center",
                className,
            )}
        >
            <button
                type="button"
                onClick={handleToggle}
                className={cn(
                    "flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] opacity-100 transition-colors focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 motion-reduce:transition-none",
                    isOpen
                        ? "bg-surface-active text-content"
                        : "text-content-muted hover:bg-surface-hover hover:text-content",
                    triggerClassName,
                )}
                aria-label={podcastRu.detail.episodeActions}
                aria-expanded={isOpen}
                aria-haspopup="dialog"
                title={podcastRu.detail.episodeActions}
            >
                <EllipsisVertical className="h-4 w-4" />
            </button>

            <Modal
                isOpen={isOpen}
                onClose={() => setIsOpen(false)}
                title={podcastRu.detail.episodeActions}
                className="sm:max-w-sm"
            >
                <div className="space-y-1">
                    <button
                        type="button"
                        onClick={handlePlayNext}
                        className="flex min-h-11 w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left text-sm text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                        title={podcastRu.detail.playNext}
                    >
                        <ListEnd className="h-4 w-4" />
                        {podcastRu.detail.playNext}
                    </button>
                    <button
                        type="button"
                        onClick={handleAddToQueue}
                        className="flex min-h-11 w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left text-sm text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                        title={podcastRu.detail.addToQueue}
                    >
                        <ListPlus className="h-4 w-4" />
                        {podcastRu.detail.addToQueue}
                    </button>
                </div>
            </Modal>
        </div>
    );
}
