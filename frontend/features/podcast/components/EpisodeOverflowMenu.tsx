"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { EllipsisVertical, ListEnd, ListPlus } from "lucide-react";
import { cn } from "@/utils/cn";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Episode } from "../types";
import { podcastRu } from "@/lib/i18n/podcastRu";

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
    const menuRef = useRef<HTMLDivElement | null>(null);
    const { addEpisodeToQueue, playEpisodeNext } = useAudioControls();

    // Outside click and escape handlers
    useEffect(() => {
        if (!isOpen) return;

        const handleOutsideClick = (event: MouseEvent) => {
            if (
                menuRef.current &&
                !menuRef.current.contains(event.target as Node)
            ) {
                setIsOpen(false);
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsOpen(false);
            }
        };

        document.addEventListener("mousedown", handleOutsideClick);
        document.addEventListener("keydown", handleEscape);

        return () => {
            document.removeEventListener("mousedown", handleOutsideClick);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [isOpen]);

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
            ref={menuRef}
            className={cn(
                "relative flex items-center justify-center",
                className,
            )}
        >
            <button
                type="button"
                onClick={handleToggle}
                className={cn(
                    "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 rounded-full p-2 transition-colors",
                    isOpen
                        ? "bg-surface-active text-content"
                        : "text-content-muted hover:bg-surface-hover hover:text-content",
                    triggerClassName,
                )}
                aria-label={podcastRu.detail.episodeActions}
                aria-expanded={isOpen}
                aria-haspopup="menu"
                title={podcastRu.detail.episodeActions}
            >
                <EllipsisVertical className="h-4 w-4" />
            </button>

            {isOpen && (
                <div
                    className="absolute right-0 top-full z-30 mt-1 min-w-[180px] rounded-xl border border-line-strong bg-surface-raised p-1 shadow-xl"
                    role="menu"
                    tabIndex={-1}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        onClick={handlePlayNext}
                        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-content-secondary transition-colors hover:bg-surface-hover hover:text-content"
                        role="menuitem"
                        title={podcastRu.detail.playNext}
                    >
                        <ListEnd className="h-4 w-4" />
                        {podcastRu.detail.playNext}
                    </button>
                    <button
                        type="button"
                        onClick={handleAddToQueue}
                        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-content-secondary transition-colors hover:bg-surface-hover hover:text-content"
                        role="menuitem"
                        title={podcastRu.detail.addToQueue}
                    >
                        <ListPlus className="h-4 w-4" />
                        {podcastRu.detail.addToQueue}
                    </button>
                </div>
            )}
        </div>
    );
}
