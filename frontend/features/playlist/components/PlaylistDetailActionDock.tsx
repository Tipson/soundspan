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
import { MusicDetailSecondaryActions } from "@/components/music-detail/MusicDetailSecondaryActions";
import { DeviceCollectionDownloadButton } from "@/features/device-offline/components/DeviceCollectionDownloadButton";
import type { Track } from "@/lib/audio-state-context";
import { ru } from "@/lib/i18n/ru";
import { cn } from "@/utils/cn";

interface PlaylistDetailActionDockProps {
    playlistId: string;
    playlistName: string;
    trackItemCount: number;
    canPlayAll?: boolean;
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
                "flex min-h-11 w-full items-center justify-start gap-3 rounded-xl px-3 text-content-secondary transition-colors hover:bg-white/10 hover:text-content active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
                className,
            )}
        >
            {icon}
            <span className="text-sm">{label}</span>
        </button>
    );
}

/** Presentation contract for playlist-level playback and management actions. */
export function PlaylistDetailActionDock({
    playlistId,
    playlistName,
    trackItemCount,
    canPlayAll = trackItemCount > 0,
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
    const primaryActionLabel =
        isThisPlaylistPlaying && isPlaying
            ? ru.common.pause
            : ru.common.playAll;

    return (
        <MusicDetailActionDock
            label={ru.playlist.controls}
            className="relative sm:!w-full"
        >
            <div
                data-detail-action-tier="primary"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
            >
                {canPlayAll && (
                    <button
                        type="button"
                        onClick={onPlay}
                        aria-label={primaryActionLabel}
                        className="flex min-h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-brand-hover px-3 py-2.5 text-sm font-semibold text-black shadow-lg transition-transform hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:flex-none sm:px-5"
                    >
                        {showPlaySpinner ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                        ) : isThisPlaylistPlaying && isPlaying ? (
                            <Pause className="h-5 w-5 fill-current" />
                        ) : (
                            <Play className="ml-0.5 h-5 w-5 fill-current" />
                        )}
                        <span
                            data-playlist-primary-label="compact"
                            className="min-w-0 truncate sm:hidden"
                        >
                            {isThisPlaylistPlaying && isPlaying
                                ? ru.common.pause
                                : ru.common.listen}
                        </span>
                        <span
                            data-playlist-primary-label="full"
                            className="hidden sm:inline"
                        >
                            {primaryActionLabel}
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

            <MusicDetailSecondaryActions>
                {(close) => (
                    <>
                        {playableTracks.length > 0 && (
                            <SecondaryAction
                                label={ru.playlist.addAllQueue}
                                icon={<ListMusic className="h-5 w-5" />}
                                onClick={() => {
                                    close();
                                    onAddAllToQueue();
                                }}
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
                                className={
                                    isAllLiked ? "text-brand" : undefined
                                }
                            />
                        )}
                        <DeviceCollectionDownloadButton
                            tracks={playableTracks}
                            collectionId={`playlist:${playlistId}`}
                            collectionLabel={playlistName}
                            className="min-h-11 w-full justify-start rounded-xl border-0 px-3 [&>span]:whitespace-normal [&>span]:text-left"
                        />
                        {trackItemCount > 0 && (
                            <SecondaryAction
                                label={ru.playlist.startRadio}
                                icon={<Radio className="h-5 w-5" />}
                                onClick={() => {
                                    close();
                                    onStartRadio();
                                }}
                            />
                        )}
                        <div className="contents [&_button]:min-h-11 [&_button]:w-full [&_button]:justify-start [&_button]:rounded-xl">
                            {radioActions}
                        </div>

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
                                onClick={() => {
                                    close();
                                    onOpenShare();
                                }}
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
                                onClick={() => {
                                    close();
                                    onDelete();
                                }}
                                className="text-content-muted hover:bg-red-500/10 hover:text-red-300 focus-visible:ring-red-300"
                            />
                        )}
                    </>
                )}
            </MusicDetailSecondaryActions>
        </MusicDetailActionDock>
    );
}
