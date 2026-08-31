"use client";

import type { ReactNode } from "react";
import {
    Eye,
    EyeOff,
    Globe,
    GlobeLock,
    Heart,
    ListMusic,
    Loader2,
    Pause,
    Play,
    Radio,
    Share2,
    Shuffle,
    Trash2,
} from "lucide-react";
import { MusicDetailActionDock } from "@/components/music-detail";
import { DeviceCollectionDownloadButton } from "@/features/device-offline/components/DeviceCollectionDownloadButton";
import type { Track } from "@/lib/audio-state-context";
import { ru } from "@/lib/i18n/ru";
import { cn } from "@/utils/cn";

interface PlaylistDetailActionDockProps {
    playlistId: string;
    playlistName: string;
    trackItemCount: number;
    playableTracks: Track[];
    isThisPlaylistPlaying: boolean;
    isPlaying: boolean;
    showPlaySpinner: boolean;
    isAllLiked: boolean;
    isApplyingLikeAll: boolean;
    isOwner: boolean;
    isPublic: boolean;
    isHidden: boolean;
    isTogglingShare: boolean;
    isHiding: boolean;
    radioActions: ReactNode;
    onPlay: () => void;
    onShuffle: () => void;
    onAddAllToQueue: () => void;
    onToggleLikeAll: () => void;
    onStartRadio: () => void;
    onToggleShare: () => void;
    onOpenShare: () => void;
    onToggleHide: () => void;
    onDelete: () => void;
}

/** Presentation contract for playlist-level playback and management actions. */
export function PlaylistDetailActionDock({
    playlistId,
    playlistName,
    trackItemCount,
    playableTracks,
    isThisPlaylistPlaying,
    isPlaying,
    showPlaySpinner,
    isAllLiked,
    isApplyingLikeAll,
    isOwner,
    isPublic,
    isHidden,
    isTogglingShare,
    isHiding,
    radioActions,
    onPlay,
    onShuffle,
    onAddAllToQueue,
    onToggleLikeAll,
    onStartRadio,
    onToggleShare,
    onOpenShare,
    onToggleHide,
    onDelete,
}: PlaylistDetailActionDockProps) {
    const likeLabel = isAllLiked ? ru.playlist.unlikeAll : ru.playlist.likeAll;
    const shareLabel = isPublic
        ? ru.playlist.makePrivate
        : ru.playlist.shareWithOthers;
    const visibilityLabel = isHidden ? ru.playlist.show : ru.playlist.hide;

    return (
        <MusicDetailActionDock
            label={ru.playlist.controls}
            className="sm:!w-full"
        >
            <div
                data-detail-action-tier="primary"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
            >
                {trackItemCount > 0 && (
                    <button
                        type="button"
                        onClick={onPlay}
                        className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-brand-hover px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:flex-none"
                    >
                        {showPlaySpinner ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                        ) : isThisPlaylistPlaying && isPlaying ? (
                            <Pause className="h-5 w-5 fill-current" />
                        ) : (
                            <Play className="ml-0.5 h-5 w-5 fill-current" />
                        )}
                        <span>
                            {isThisPlaylistPlaying && isPlaying
                                ? ru.common.pause
                                : ru.common.playAll}
                        </span>
                    </button>
                )}
                {playableTracks.length > 1 && (
                    <button
                        type="button"
                        onClick={onShuffle}
                        className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        title={ru.playlist.shufflePlay}
                        aria-label={ru.playlist.shufflePlay}
                    >
                        <Shuffle className="h-5 w-5" />
                    </button>
                )}
            </div>

            <div
                data-detail-action-tier="secondary"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
            >
                {playableTracks.length > 0 && (
                    <button
                        type="button"
                        onClick={onAddAllToQueue}
                        className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        title={ru.playlist.addAllQueue}
                        aria-label={ru.playlist.addAllQueue}
                    >
                        <ListMusic className="h-5 w-5" />
                    </button>
                )}
                {playableTracks.length > 0 && (
                    <button
                        type="button"
                        onClick={onToggleLikeAll}
                        disabled={isApplyingLikeAll}
                        className={cn(
                            "flex h-11 w-11 items-center justify-center rounded-full transition-colors active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                            isApplyingLikeAll
                                ? "cursor-not-allowed text-content-muted opacity-50"
                                : isAllLiked
                                  ? "text-brand hover:bg-white/10"
                                  : "text-content-secondary hover:bg-white/10 hover:text-content",
                        )}
                        title={likeLabel}
                        aria-label={likeLabel}
                    >
                        {isApplyingLikeAll ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Heart
                                className={cn(
                                    "h-4 w-4",
                                    isAllLiked && "fill-current",
                                )}
                            />
                        )}
                    </button>
                )}
                <DeviceCollectionDownloadButton
                    tracks={playableTracks}
                    collectionId={`playlist:${playlistId}`}
                    collectionLabel={playlistName}
                />
                {trackItemCount > 0 && (
                    <button
                        type="button"
                        onClick={onStartRadio}
                        className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        title={ru.playlist.startRadio}
                        aria-label={ru.playlist.startRadio}
                    >
                        <Radio className="h-5 w-5" />
                    </button>
                )}
                {radioActions}

                <span className="flex-1" aria-hidden="true" />

                {isOwner && (
                    <button
                        type="button"
                        onClick={onToggleShare}
                        disabled={isTogglingShare}
                        className={cn(
                            "flex h-11 w-11 items-center justify-center rounded-full transition-colors active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                            isPublic
                                ? "text-brand hover:text-brand-dark"
                                : "text-content-muted hover:text-content",
                            isTogglingShare && "cursor-not-allowed opacity-50",
                        )}
                        title={shareLabel}
                        aria-label={shareLabel}
                    >
                        {isPublic ? (
                            <Globe className="h-5 w-5" />
                        ) : (
                            <GlobeLock className="h-5 w-5" />
                        )}
                    </button>
                )}
                {isOwner && (
                    <button
                        type="button"
                        onClick={onOpenShare}
                        className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                        title={ru.playlist.shareLink}
                        aria-label={ru.playlist.shareLink}
                    >
                        <Share2 className="h-5 w-5" />
                    </button>
                )}
                <button
                    type="button"
                    onClick={onToggleHide}
                    disabled={isHiding}
                    className={cn(
                        "flex h-11 w-11 items-center justify-center rounded-full transition-colors active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                        isHidden
                            ? "text-brand hover:text-brand-dark"
                            : "text-content-muted hover:text-content",
                        isHiding && "cursor-not-allowed opacity-50",
                    )}
                    title={visibilityLabel}
                    aria-label={visibilityLabel}
                >
                    {isHidden ? (
                        <Eye className="h-5 w-5" />
                    ) : (
                        <EyeOff className="h-5 w-5" />
                    )}
                </button>
                {isOwner && (
                    <button
                        type="button"
                        onClick={onDelete}
                        className="flex h-11 w-11 items-center justify-center rounded-full text-content-muted transition-colors hover:bg-red-500/10 hover:text-red-300 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 motion-reduce:transition-none"
                        title={ru.playlist.delete}
                        aria-label={ru.playlist.delete}
                    >
                        <Trash2 className="h-5 w-5" />
                    </button>
                )}
            </div>
        </MusicDetailActionDock>
    );
}
