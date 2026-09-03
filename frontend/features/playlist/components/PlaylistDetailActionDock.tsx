"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    Ellipsis,
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

interface SecondaryActionProps {
    label: string;
    icon: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    className?: string;
}

function SecondaryAction({
    label,
    icon,
    onClick,
    disabled = false,
    className,
}: SecondaryActionProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={label}
            aria-label={label}
            className={cn(
                "flex min-h-11 w-full items-center justify-start gap-3 rounded-xl px-3 text-content-secondary transition-colors hover:bg-white/10 hover:text-content active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none sm:h-11 sm:w-11 sm:justify-center sm:rounded-full sm:px-0",
                className,
            )}
        >
            {icon}
            <span className="text-sm sm:sr-only">{label}</span>
        </button>
    );
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
    const [isMoreOpen, setIsMoreOpen] = useState(false);
    const moreActionsRef = useRef<HTMLDivElement | null>(null);
    const likeLabel = isAllLiked ? ru.playlist.unlikeAll : ru.playlist.likeAll;
    const shareLabel = isPublic
        ? ru.playlist.makePrivate
        : ru.playlist.shareWithOthers;
    const visibilityLabel = isHidden ? ru.playlist.show : ru.playlist.hide;

    useEffect(() => {
        if (!isMoreOpen) return;
        const closeOnOutsideClick = (event: MouseEvent) => {
            if (
                moreActionsRef.current &&
                !moreActionsRef.current.contains(event.target as Node)
            ) {
                setIsMoreOpen(false);
            }
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setIsMoreOpen(false);
        };
        document.addEventListener("mousedown", closeOnOutsideClick);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("mousedown", closeOnOutsideClick);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [isMoreOpen]);

    return (
        <MusicDetailActionDock
            label={ru.playlist.controls}
            className="relative sm:!w-full"
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

            <div ref={moreActionsRef} className="relative sm:contents">
                <button
                    type="button"
                    data-playlist-actions-overflow
                    onClick={() => setIsMoreOpen((open) => !open)}
                    aria-label="Ещё действия с плейлистом"
                    aria-expanded={isMoreOpen}
                    aria-controls="playlist-secondary-actions"
                    className="flex h-11 w-11 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light sm:hidden"
                >
                    <Ellipsis className="h-5 w-5" aria-hidden="true" />
                </button>

                <div
                    data-detail-action-tier="secondary"
                    id="playlist-secondary-actions"
                    role="group"
                    aria-label="Действия с плейлистом"
                    className={cn(
                        "absolute right-0 top-[calc(100%+0.5rem)] z-40 min-w-[17rem] flex-col gap-1 rounded-2xl border border-line bg-surface-overlay p-2 shadow-2xl",
                        isMoreOpen ? "flex" : "hidden",
                        "sm:static sm:z-auto sm:flex sm:min-w-0 sm:flex-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none",
                    )}
                    onClick={() => setIsMoreOpen(false)}
                >
                    {playableTracks.length > 0 && (
                        <SecondaryAction
                            label={ru.playlist.addAllQueue}
                            icon={<ListMusic className="h-5 w-5" />}
                            onClick={onAddAllToQueue}
                        />
                    )}
                    {playableTracks.length > 0 && (
                        <SecondaryAction
                            label={likeLabel}
                            icon={
                                isApplyingLikeAll ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Heart
                                        className={cn(
                                            "h-4 w-4",
                                            isAllLiked && "fill-current",
                                        )}
                                    />
                                )
                            }
                            onClick={onToggleLikeAll}
                            disabled={isApplyingLikeAll}
                            className={isAllLiked ? "text-brand" : undefined}
                        />
                    )}
                    <DeviceCollectionDownloadButton
                        tracks={playableTracks}
                        collectionId={`playlist:${playlistId}`}
                        collectionLabel={playlistName}
                        className="w-full justify-start rounded-xl border-0 px-3 sm:w-auto sm:justify-center sm:rounded-full sm:border sm:px-4"
                    />
                    {trackItemCount > 0 && (
                        <SecondaryAction
                            label={ru.playlist.startRadio}
                            icon={<Radio className="h-5 w-5" />}
                            onClick={onStartRadio}
                        />
                    )}
                    {radioActions}

                    <span
                        className="hidden flex-1 sm:block"
                        aria-hidden="true"
                    />

                    {isOwner && (
                        <SecondaryAction
                            label={shareLabel}
                            icon={
                                isPublic ? (
                                    <Globe className="h-5 w-5" />
                                ) : (
                                    <GlobeLock className="h-5 w-5" />
                                )
                            }
                            onClick={onToggleShare}
                            disabled={isTogglingShare}
                            className={isPublic ? "text-brand" : undefined}
                        />
                    )}
                    {isOwner && (
                        <SecondaryAction
                            label={ru.playlist.shareLink}
                            icon={<Share2 className="h-5 w-5" />}
                            onClick={onOpenShare}
                        />
                    )}
                    <SecondaryAction
                        label={visibilityLabel}
                        icon={
                            isHidden ? (
                                <Eye className="h-5 w-5" />
                            ) : (
                                <EyeOff className="h-5 w-5" />
                            )
                        }
                        onClick={onToggleHide}
                        disabled={isHiding}
                        className={isHidden ? "text-brand" : undefined}
                    />
                    {isOwner && (
                        <SecondaryAction
                            label={ru.playlist.delete}
                            icon={<Trash2 className="h-5 w-5" />}
                            onClick={onDelete}
                            className="text-content-muted hover:bg-red-500/10 hover:text-red-300 focus-visible:ring-red-300"
                        />
                    )}
                </div>
            </div>
        </MusicDetailActionDock>
    );
}
