"use client";

import {
    Play,
    Pause,
    RefreshCw,
    Settings,
    Loader2,
    Plus,
    Shuffle,
    ListMusic,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { Button } from "@/components/ui/Button";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import type { DiscoverPlaylist, DiscoverConfig } from "../types";
import { discoverRu } from "@/lib/i18n/discoverRu";

interface BatchStatus {
    active: boolean;
    status: "downloading" | "scanning" | "generating" | null;
    progress?: number;
    completed?: number;
    failed?: number;
    total?: number;
}

interface DiscoverActionBarProps {
    playlist: DiscoverPlaylist | null;
    config: DiscoverConfig | null;
    isPlaylistPlaying: boolean;
    isPlaying: boolean;
    onPlayToggle: () => void;
    onGenerate: () => void;
    onToggleSettings: () => void;
    onAddToPlaylist?: () => void;
    onShuffle?: () => void;
    onAddAllToQueue?: () => void;
    isGenerating: boolean;
    batchStatus?: BatchStatus | null;
}

/**
 * Renders the DiscoverActionBar component.
 */
export function DiscoverActionBar({
    playlist,
    config,
    isPlaylistPlaying,
    isPlaying,
    onPlayToggle,
    onGenerate,
    onToggleSettings,
    onAddToPlaylist,
    onShuffle,
    onAddAllToQueue,
    isGenerating,
    batchStatus,
}: DiscoverActionBarProps) {
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();

    const getStatusText = () => {
        if (!isGenerating) return null;

        if (batchStatus?.status === "scanning") {
            return discoverRu.status.finalizing;
        }

        if (batchStatus?.status === "generating") {
            return discoverRu.status.refreshing;
        }

        if (batchStatus?.total) {
            return `${discoverRu.status.progress}: ${batchStatus.completed || 0}%`;
        }

        return discoverRu.status.starting;
    };

    const handlePlayToggle = () => {
        triggerPlayFeedback();
        onPlayToggle();
    };

    return (
        <div className="rounded-2xl border border-line bg-surface-elevated p-2 sm:p-3">
            <div className="flex flex-wrap items-center gap-2">
                {/* Play Button */}
                {playlist && playlist.tracks.length > 0 && (
                    <Button
                        variant="ai"
                        onClick={handlePlayToggle}
                        disabled={isGenerating}
                        className={cn(
                            "rounded-full px-5 text-sm",
                            isGenerating
                                ? "cursor-not-allowed"
                                : "shadow-lg shadow-ai/5",
                        )}
                    >
                        {showSpinner ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                        ) : isPlaylistPlaying && isPlaying ? (
                            <Pause className="w-5 h-5 fill-current" />
                        ) : (
                            <Play className="w-5 h-5 fill-current ml-0.5" />
                        )}
                        <span>
                            {isPlaylistPlaying && isPlaying
                                ? discoverRu.action.pause
                                : discoverRu.action.playAll}
                        </span>
                    </Button>
                )}

                {/* Shuffle Button */}
                {playlist && playlist.tracks.length > 0 && onShuffle && (
                    <Button
                        variant="icon"
                        onClick={onShuffle}
                        disabled={isGenerating}
                        title={discoverRu.action.shuffleAll}
                        aria-label={discoverRu.action.shuffleAll}
                    >
                        <Shuffle className="size-5" />
                    </Button>
                )}

                {/* Add to Queue Button */}
                {playlist && playlist.tracks.length > 0 && onAddAllToQueue && (
                    <Button
                        variant="icon"
                        onClick={onAddAllToQueue}
                        disabled={isGenerating}
                        title={discoverRu.action.addAllToQueue}
                        aria-label={discoverRu.action.addAllToQueue}
                    >
                        <ListMusic className="size-5" />
                    </Button>
                )}

                {/* Add to Playlist Button */}
                {playlist && playlist.tracks.length > 0 && onAddToPlaylist && (
                    <Button
                        variant="icon"
                        onClick={onAddToPlaylist}
                        title={discoverRu.action.addAllToPlaylist}
                        aria-label={discoverRu.action.addAllToPlaylist}
                    >
                        <Plus className="size-5" />
                    </Button>
                )}

                {/* Regenerate Button (icon only) */}
                <Button
                    variant="icon"
                    onClick={onGenerate}
                    disabled={isGenerating || !config?.enabled}
                    title={
                        isGenerating
                            ? getStatusText() || discoverRu.action.generating
                            : playlist
                              ? discoverRu.action.regenerate
                              : discoverRu.action.generate
                    }
                    aria-label={
                        isGenerating
                            ? getStatusText() || discoverRu.action.generating
                            : playlist
                              ? discoverRu.action.regenerate
                              : discoverRu.action.generate
                    }
                >
                    {isGenerating ? (
                        <GradientSpinner size="sm" />
                    ) : (
                        <RefreshCw className="size-5" />
                    )}
                </Button>

                {isGenerating && (
                    <span
                        aria-live="polite"
                        className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-content-muted"
                    >
                        {getStatusText()}
                    </span>
                )}

                {/* Settings Button (far right) */}
                <Button
                    variant="icon"
                    onClick={onToggleSettings}
                    disabled={isGenerating}
                    className="ml-auto"
                    title={discoverRu.action.settings}
                    aria-label={discoverRu.action.settings}
                >
                    <Settings className="size-5" />
                </Button>
            </div>
        </div>
    );
}
