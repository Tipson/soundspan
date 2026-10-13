"use client";
import { CollectionPlaybackButton } from "@/components/music-detail/CollectionPlaybackButton";
import { MusicDetailSecondaryActions } from "@/components/music-detail/MusicDetailSecondaryActions";

import { RefreshCw, Settings, Plus, Shuffle, ListMusic } from "lucide-react";
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
    const onlineWeekly = playlist?.kind === "online-weekly";

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
        <div className="mt-5 mb-2">
            <div className="flex min-h-14 items-center gap-2">
                {playlist && playlist.tracks.length > 0 && (
                    <CollectionPlaybackButton
                        onClick={handlePlayToggle}
                        disabled={isGenerating}
                        isLoading={showSpinner}
                        isPlaying={isPlaylistPlaying && isPlaying}
                    />
                )}
                {playlist && playlist.tracks.length > 0 && onShuffle && (
                    <Button
                        variant="icon"
                        onClick={onShuffle}
                        disabled={isGenerating}
                        title={discoverRu.action.shuffleAll}
                        aria-label={discoverRu.action.shuffleAll}
                    >
                        <Shuffle className="size-5" aria-hidden="true" />
                    </Button>
                )}
                <MusicDetailSecondaryActions>
                    {(close) => (
                        <>
                            {playlist &&
                                playlist.tracks.length > 0 &&
                                onAddAllToQueue && (
                                    <Button
                                        variant="ghost"
                                        onClick={() => {
                                            close();
                                            onAddAllToQueue();
                                        }}
                                        disabled={isGenerating}
                                        title={discoverRu.action.addAllToQueue}
                                        aria-label={
                                            discoverRu.action.addAllToQueue
                                        }
                                    >
                                        <ListMusic
                                            className="size-5"
                                            aria-hidden="true"
                                        />
                                        {discoverRu.action.addAllToQueue}
                                    </Button>
                                )}
                            {playlist &&
                                playlist.tracks.length > 0 &&
                                onAddToPlaylist && (
                                    <Button
                                        variant="ghost"
                                        onClick={() => {
                                            close();
                                            onAddToPlaylist();
                                        }}
                                        title={
                                            discoverRu.action.addAllToPlaylist
                                        }
                                        aria-label={
                                            discoverRu.action.addAllToPlaylist
                                        }
                                    >
                                        <Plus
                                            className="size-5"
                                            aria-hidden="true"
                                        />
                                        {discoverRu.action.addAllToPlaylist}
                                    </Button>
                                )}
                            {!onlineWeekly && (
                                <>
                                    <Button
                                        variant="ghost"
                                        onClick={() => {
                                            close();
                                            onGenerate();
                                        }}
                                        disabled={
                                            isGenerating || !config?.enabled
                                        }
                                        title={
                                            isGenerating
                                                ? getStatusText() ||
                                                  discoverRu.action.generating
                                                : playlist
                                                  ? discoverRu.action.regenerate
                                                  : discoverRu.action.generate
                                        }
                                        aria-label={
                                            isGenerating
                                                ? getStatusText() ||
                                                  discoverRu.action.generating
                                                : playlist
                                                  ? discoverRu.action.regenerate
                                                  : discoverRu.action.generate
                                        }
                                    >
                                        {isGenerating ? (
                                            <GradientSpinner size="sm" />
                                        ) : (
                                            <RefreshCw
                                                className="size-5"
                                                aria-hidden="true"
                                            />
                                        )}
                                        {isGenerating
                                            ? getStatusText() ||
                                              discoverRu.action.generating
                                            : playlist
                                              ? discoverRu.action.regenerate
                                              : discoverRu.action.generate}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        onClick={() => {
                                            close();
                                            onToggleSettings();
                                        }}
                                        disabled={isGenerating}
                                        title={discoverRu.action.settings}
                                        aria-label={discoverRu.action.settings}
                                    >
                                        <Settings
                                            className="size-5"
                                            aria-hidden="true"
                                        />
                                        {discoverRu.action.settings}
                                    </Button>
                                </>
                            )}
                        </>
                    )}
                </MusicDetailSecondaryActions>
            </div>
            {isGenerating && !onlineWeekly && (
                <p
                    role="status"
                    aria-live="polite"
                    className="mt-3 text-sm text-content-secondary"
                >
                    {getStatusText()}
                </p>
            )}
        </div>
    );
}
