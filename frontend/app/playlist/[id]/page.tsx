"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
    api,
    type PlaylistDetailTrackItem,
    type PlaylistPendingTrackItem,
} from "@/lib/api";
import {
    useAudioState,
    usePlaybackStatus,
    useAudioControls,
} from "@/lib/audio-context";
import { cn } from "@/utils/cn";
import { shuffleArray } from "@/utils/shuffle";
import { formatTime } from "@/utils/formatTime";
import { usePlaylistQuery } from "@/hooks/useQueries";
import {
    getUnplayableMessage,
    isLocalPlayableTrackItem,
    isPlayableTrackItem,
    selectPlaylistPlaybackQueue,
    toAudioTrack,
    TRACK_REMOVED_TOOLTIP,
} from "@/lib/playlistItemPlayback";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import {
    TrackOverflowMenu,
    TrackMenuButton,
} from "@/components/ui/TrackOverflowMenu";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { PeerBadge } from "@/components/ui/PeerBadge";
import {
    TrackList as SharedTrackList,
    TrackListHeader,
    UnplayableBadge,
} from "@/components/track";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/lib/toast-context";
import {
    movePlaylistItemToIndexInCache,
    removePlaylistItemFromCache,
} from "./playlistCacheUpdates";
import { useDownloadContext } from "@/lib/download-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import {
    Play,
    ArrowDown,
    ArrowUp,
    ArrowUpToLine,
    Trash2,
    ListMusic,
    Volume2,
    RefreshCw,
    AlertCircle,
    X,
    Loader2,
} from "lucide-react";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { useCollectionLikeAll } from "@/hooks/useCollectionLikeAll";
import { ShareLinkModal } from "@/components/ui/ShareLinkModal";
import { RadioPlaylistActions } from "./RadioPlaylistActions";
import { formatPlaylistDuration } from "./playlistDuration";
import { queryKeys } from "@/lib/queryKeys";
import { MusicDetailTrackSurface } from "@/components/music-detail";
import { PlaylistDetailHero } from "@/features/playlist/components/PlaylistDetailHero";
import { PlaylistDetailActionDock } from "@/features/playlist/components/PlaylistDetailActionDock";
import { pluralRu, ru } from "@/lib/i18n/ru";
import {
    buildPlaylistCoverUrls,
    buildPlaylistLikeableTracks,
} from "./playlistViewModel";

type PlaylistItem = PlaylistDetailTrackItem;
type PendingTrack = PlaylistPendingTrackItem;

/**
 * Renders the PlaylistDetailPage component.
 */
export default function PlaylistDetailPage() {
    const params = useParams();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = usePlaybackStatus();
    const { playTracks, pause, resume, addTracksToQueue } = useAudioControls();
    const playlistId = params.id as string;

    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isHiding, setIsHiding] = useState(false);
    const [isTogglingShare, setIsTogglingShare] = useState(false);
    const [showShareModal, setShowShareModal] = useState(false);
    const [playingPreviewId, setPlayingPreviewId] = useState<string | null>(
        null,
    );
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
        usePlayButtonFeedback();
    const [retryingTrackId, setRetryingTrackId] = useState<string | null>(null);
    const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);
    const [isRenaming, setIsRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState("");
    const [isSavingName, setIsSavingName] = useState(false);
    const renameInputRef = useRef<HTMLInputElement | null>(null);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);

    // Clean up preview audio on unmount
    useEffect(() => {
        return () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current = null;
            }
        };
    }, []);

    // Handle Deezer preview playback
    const handlePlayPreview = async (pendingId: string) => {
        // If already playing this preview, stop it
        if (playingPreviewId === pendingId && previewAudioRef.current) {
            previewAudioRef.current.pause();
            setPlayingPreviewId(null);
            return;
        }

        // Stop any currently playing preview
        if (previewAudioRef.current) {
            previewAudioRef.current.pause();
        }

        // Show loading state
        setPlayingPreviewId(pendingId);

        try {
            // Always fetch a fresh preview URL since Deezer URLs expire quickly
            const result = await api.getFreshPreviewUrl(playlistId, pendingId);
            const previewUrl = result.previewUrl;

            // Create and play new audio
            const audio = new Audio(previewUrl);
            audio.volume = 0.5;
            audio.onended = () => setPlayingPreviewId(null);
            audio.onerror = (e) => {
                sharedFrontendLogger.error(
                    "Deezer preview playback failed:",
                    e,
                );
                setPlayingPreviewId(null);
                toast.error(ru.playlist.previewFailed);
            };
            previewAudioRef.current = audio;

            await audio.play();
        } catch (err) {
            sharedFrontendLogger.error("Failed to play Deezer preview:", err);
            setPlayingPreviewId(null);
            toast.error(ru.playlist.noPreview);
        }
    };

    // Handle retry download for pending track
    const { downloadsEnabled } = useDownloadContext();
    const handleRetryPendingTrack = async (pendingId: string) => {
        setRetryingTrackId(pendingId);
        try {
            const result = await api.retryPendingTrack(playlistId, pendingId);
            if (result.success) {
                // Use the activity sidebar (Active tab) instead of a toast/modal
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", {
                        detail: { tab: "active" },
                    }),
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                // If the backend emits a scan/download notification, refresh it
                window.dispatchEvent(new CustomEvent("notifications-changed"));
                // Refresh playlist data after a delay to allow download + scan to complete
                setTimeout(() => {
                    queryClient.invalidateQueries({
                        queryKey: queryKeys.playlist(playlistId),
                    });
                }, 10000); // 10 seconds for download + scan
            } else {
                toast.error(result.message || ru.playlist.soulseekMissing);
            }
        } catch (error) {
            sharedFrontendLogger.error("Failed to retry download:", error);
            toast.error(ru.playlist.retryFailed);
        } finally {
            setRetryingTrackId(null);
        }
    };

    // Handle remove pending track
    const handleRemovePendingTrack = async (pendingId: string) => {
        setRemovingTrackId(pendingId);
        try {
            await api.removePendingTrack(playlistId, pendingId);
            // Refresh playlist data
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlist(playlistId),
            });
        } catch (error) {
            sharedFrontendLogger.error(
                "Failed to remove pending track:",
                error,
            );
        } finally {
            setRemovingTrackId(null);
        }
    };

    // Use React Query hook for playlist
    const { data: playlist, isLoading } = usePlaylistQuery(playlistId);

    // Check if this is a shared playlist
    const isShared = playlist?.isOwner === false;

    const handleToggleShare = async () => {
        if (!playlist) return;
        setIsTogglingShare(true);
        try {
            await api.updatePlaylist(playlistId, {
                isPublic: !playlist.isPublic,
            });

            queryClient.setQueryData(
                ["playlist", playlistId],
                (old: Record<string, unknown>) => ({
                    ...old,
                    isPublic: !playlist.isPublic,
                }),
            );

            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } }),
            );
        } catch (error) {
            sharedFrontendLogger.error(
                "Failed to toggle playlist sharing:",
                error,
            );
            toast.error(ru.playlist.sharingFailed);
        } finally {
            setIsTogglingShare(false);
        }
    };

    const renameTriggerRef = useRef<HTMLButtonElement | null>(null);

    const handleStartRename = () => {
        if (!playlist) return;
        setRenameValue(playlist.name);
        setIsRenaming(true);
        // Auto-focus + select after render
        setTimeout(() => {
            renameInputRef.current?.focus();
            renameInputRef.current?.select();
        }, 0);
    };

    const handleRename = async () => {
        if (!playlist || isSavingName) return;
        const trimmed = renameValue.trim();
        if (!trimmed || trimmed === playlist.name) {
            setIsRenaming(false);
            // Return focus to edit trigger
            setTimeout(() => renameTriggerRef.current?.focus(), 0);
            return;
        }
        setIsSavingName(true);
        const previousName = playlist.name;
        try {
            // Optimistic update
            queryClient.setQueryData(
                ["playlist", playlistId],
                (old: Record<string, unknown>) => ({
                    ...old,
                    name: trimmed,
                }),
            );
            await api.updatePlaylist(playlistId, { name: trimmed });
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } }),
            );
        } catch (error) {
            sharedFrontendLogger.error("Failed to rename playlist:", error);
            toast.error(ru.playlist.renameFailed);
            // Revert optimistic update
            queryClient.setQueryData(
                ["playlist", playlistId],
                (old: Record<string, unknown>) => ({
                    ...old,
                    name: previousName,
                }),
            );
        } finally {
            setIsSavingName(false);
            setIsRenaming(false);
            // Return focus to edit trigger
            setTimeout(() => renameTriggerRef.current?.focus(), 0);
        }
    };

    const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            handleRename();
        } else if (e.key === "Escape") {
            e.preventDefault();
            setIsRenaming(false);
            // Return focus to edit trigger
            setTimeout(() => renameTriggerRef.current?.focus(), 0);
        }
    };

    const handleToggleHide = async () => {
        if (!playlist) return;
        setIsHiding(true);
        try {
            if (playlist.isHidden) {
                await api.unhidePlaylist(playlistId);
            } else {
                await api.hidePlaylist(playlistId);
            }

            // Update local state immediately
            queryClient.setQueryData(
                ["playlist", playlistId],
                (old: Record<string, unknown>) => ({
                    ...old,
                    isHidden: !playlist.isHidden,
                }),
            );

            // Dispatch event to update sidebar and other components
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } }),
            );

            // Optionally navigate away if hiding
            if (!playlist.isHidden) {
                router.push("/playlists");
            }
        } catch (error) {
            sharedFrontendLogger.error(
                "Failed to toggle playlist visibility:",
                error,
            );
        } finally {
            setIsHiding(false);
        }
    };

    const trackItems = useMemo(
        () => (playlist?.items as PlaylistItem[] | undefined) || [],
        [playlist?.items],
    );

    const playableTrackItems = useMemo(
        () => trackItems.filter((item) => isPlayableTrackItem(item)),
        [trackItems],
    );

    const unplayableTrackItems = useMemo(
        () =>
            trackItems.filter(
                (item) =>
                    item.track === null || item.playback?.isPlayable === false,
            ),
        [trackItems],
    );

    const playableTracks = useMemo(
        () => playableTrackItems.map((item) => toAudioTrack(item)),
        [playableTrackItems],
    );

    const likeableTracks = useMemo(
        () => buildPlaylistLikeableTracks(playableTrackItems),
        [playableTrackItems],
    );
    const {
        isAllLiked,
        isApplying: isApplyingLikeAll,
        toggleLikeAll,
    } = useCollectionLikeAll(likeableTracks);

    const handleAddAllToQueue = () => {
        if (playableTracks.length === 0) return;
        addTracksToQueue(playableTracks);
        toast.success(
            `${ru.playlist.addedToQueue}: ${playableTracks.length} ${pluralRu(playableTracks.length, ["трек", "трека", "треков"])}`,
        );
    };

    const coverUrls = useMemo(
        () => buildPlaylistCoverUrls(trackItems),
        [trackItems],
    );

    const handleRemoveTrack = async (itemIdOrTrackId: string) => {
        try {
            await api.removeTrackFromPlaylist(playlistId, itemIdOrTrackId);
            // Drop the row from the cached playlist immediately (the page
            // reads through React Query, so without this the stale cache
            // kept showing the removed track — GH #34), then refetch for
            // authoritative state.
            queryClient.setQueryData(
                ["playlist", playlistId],
                (old: Record<string, unknown> | undefined) =>
                    removePlaylistItemFromCache(
                        old as
                            | {
                                  items?: {
                                      id: string;
                                      trackId?: string | null;
                                  }[];
                              }
                            | undefined,
                        itemIdOrTrackId,
                    ),
            );
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlist(playlistId),
            });
        } catch (error) {
            sharedFrontendLogger.error("Failed to remove track:", error);
            toast.error(ru.playlist.removeFailed);
        }
    };

    const handleMoveTrack = async (itemId: string, toIndex: number) => {
        // Optimistic reorder in the cached payload, then persist the full
        // resulting order (the backend replaces positions wholesale) and
        // refetch for authoritative state — same shape as remove (GH #34).
        const cached = queryClient.getQueryData<{
            items?: { id: string; trackId?: string | null }[];
        }>(["playlist", playlistId]);
        const moved = movePlaylistItemToIndexInCache(cached, itemId, toIndex);
        if (!moved || moved === cached || !Array.isArray(moved.items)) {
            return;
        }
        queryClient.setQueryData(["playlist", playlistId], moved);
        try {
            await api.reorderPlaylistItems(
                playlistId,
                moved.items.map((entry) => entry.id),
            );
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlist(playlistId),
            });
        } catch (error) {
            sharedFrontendLogger.error("Failed to reorder playlist:", error);
            toast.error(ru.playlist.reorderFailed);
            // Restore the server's order.
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlist(playlistId),
            });
        }
    };

    const handleReorderByIndex = (fromIndex: number, toIndex: number) => {
        // TrackList row indexes map 1:1 onto playlist.items (trackItems is
        // the unfiltered items array).
        const item = trackItems[fromIndex];
        if (!item) return;
        void handleMoveTrack(item.id, toIndex);
    };

    const handleDeletePlaylist = async () => {
        try {
            await api.deletePlaylist(playlistId);

            // Dispatch event to update sidebar
            window.dispatchEvent(
                new CustomEvent("playlist-deleted", { detail: { playlistId } }),
            );

            router.push("/playlists");
        } catch (error) {
            sharedFrontendLogger.error("Failed to delete playlist:", error);
        }
    };

    // Check if this playlist is currently playing
    const playlistTrackIds = useMemo(() => {
        return new Set(playableTracks.map((track) => track.id));
    }, [playableTracks]);

    const isThisPlaylistPlaying = useMemo(() => {
        if (!isPlaying || !currentTrack || playableTracks.length === 0)
            return false;
        // Check if current track is in this playlist
        return playlistTrackIds.has(currentTrack.id);
    }, [isPlaying, currentTrack, playlistTrackIds, playableTracks.length]);

    // Calculate total duration - MUST be before early returns
    const totalDuration = useMemo(() => {
        if (trackItems.length === 0) return 0;
        return trackItems.reduce(
            (sum: number, item: PlaylistItem) =>
                sum + (item.track?.duration || 0),
            0,
        );
    }, [trackItems]);

    const handlePlayPlaylist = () => {
        if (trackItems.length === 0) return;

        // If this playlist is playing, toggle pause/resume
        if (isThisPlaylistPlaying) {
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
            return;
        }

        if (playableTracks.length === 0) {
            toast.error(ru.playlist.noPlayable);
            return;
        }

        triggerPlayFeedback();
        playTracks(playableTracks, 0);
    };

    const handleShufflePlaylist = () => {
        if (playableTracks.length < 2) return;
        playTracks(shuffleArray(playableTracks), 0);
    };

    const handlePlayTrack = (itemId: string) => {
        const item = trackItems.find((entry) => entry.id === itemId);
        if (!item) return;
        const fallbackMessage = getUnplayableMessage(item);
        if (!isPlayableTrackItem(item)) {
            toast.error(fallbackMessage);
            return;
        }
        const selection = selectPlaylistPlaybackQueue(trackItems, itemId);
        if (selection.startIndex >= 0)
            playTracks(selection.tracks, selection.startIndex);
    };

    const handleStartRadio = async () => {
        try {
            toast.info(ru.playlist.startingRadio);
            const response = await api.getRadioTracks("playlist", playlistId);
            if (response.tracks && response.tracks.length > 0) {
                const tracks = response.tracks.map(
                    (t: Record<string, unknown>) => ({
                        id: t.id as string,
                        title: t.title as string,
                        artist: t.artist as { name: string; id?: string },
                        album: t.album as {
                            title: string;
                            coverArt?: string;
                            id?: string;
                        },
                        duration: t.duration as number,
                    }),
                );
                playTracks(tracks, 0);
                toast.success(
                    `Радио запущено: ${tracks.length} ${pluralRu(tracks.length, ["трек", "трека", "треков"])}`,
                );
            } else {
                toast.error(ru.playlist.noRadioTracks);
            }
        } catch (error) {
            sharedFrontendLogger.error(
                "Failed to start playlist radio:",
                error,
            );
            toast.error(ru.playlist.radioFailed);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!playlist) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <p className="text-gray-400">{ru.playlist.notFound}</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            <PlaylistDetailHero
                name={playlist.name}
                coverUrls={coverUrls}
                kindLabel={
                    isShared ? ru.playlist.sharedPlaylist : ru.playlist.playlist
                }
                ownerName={isShared ? playlist.user?.username : undefined}
                trackCount={trackItems.length}
                durationLabel={
                    totalDuration > 0
                        ? formatPlaylistDuration(totalDuration)
                        : undefined
                }
                isOwner={playlist.isOwner === true}
                isRenaming={isRenaming}
                renameValue={renameValue}
                isSavingName={isSavingName}
                renameInputRef={renameInputRef}
                renameTriggerRef={renameTriggerRef}
                onRenameChange={(event) => setRenameValue(event.target.value)}
                onRenameBlur={handleRename}
                onRenameKeyDown={handleRenameKeyDown}
                onStartRename={handleStartRename}
                actions={
                    <PlaylistDetailActionDock
                        playlistId={playlistId}
                        playlistName={playlist.name}
                        trackItemCount={trackItems.length}
                        playableTracks={playableTracks}
                        isThisPlaylistPlaying={isThisPlaylistPlaying}
                        isPlaying={isPlaying}
                        showPlaySpinner={showPlaySpinner}
                        isAllLiked={isAllLiked}
                        isApplyingLikeAll={isApplyingLikeAll}
                        isOwner={playlist.isOwner}
                        isPublic={playlist.isPublic}
                        isHidden={playlist.isHidden}
                        isTogglingShare={isTogglingShare}
                        isHiding={isHiding}
                        radioActions={
                            <RadioPlaylistActions
                                enabled={Boolean(
                                    playlist.isOwner &&
                                    playlist.mixId?.startsWith(
                                        "radio-ephemeral:",
                                    ),
                                )}
                                playlistId={playlistId}
                            />
                        }
                        onPlay={handlePlayPlaylist}
                        onShuffle={handleShufflePlaylist}
                        onAddAllToQueue={handleAddAllToQueue}
                        onToggleLikeAll={() => void toggleLikeAll()}
                        onStartRadio={() => void handleStartRadio()}
                        onToggleShare={() => void handleToggleShare()}
                        onOpenShare={() => setShowShareModal(true)}
                        onToggleHide={() => void handleToggleHide()}
                        onDelete={() => setShowDeleteConfirm(true)}
                    />
                }
            />

            {/* Track Listing */}
            <div className="mx-auto max-w-[1800px] px-4 pt-2 sm:px-6 lg:px-8">
                {/* Show failed/pending count if any */}
                {playlist.pendingCount > 0 && (
                    <div className="mb-4 flex items-center gap-2 rounded-2xl border border-red-500/30 bg-red-900/20 px-4 py-3">
                        <AlertCircle className="w-4 h-4 text-red-400" />
                        <span className="text-sm text-red-200">
                            Не удалось загрузить {playlist.pendingCount}{" "}
                            {pluralRu(playlist.pendingCount, [
                                "трек",
                                "трека",
                                "треков",
                            ])}
                            . Soundspan импортирует их автоматически, когда они
                            станут доступны.
                        </span>
                    </div>
                )}

                {unplayableTrackItems.length > 0 && (
                    <div className="mb-4 flex items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-900/20 px-4 py-3">
                        <AlertCircle className="w-4 h-4 text-amber-300" />
                        <span className="text-sm text-amber-100">
                            Сейчас недоступно: {unplayableTrackItems.length}{" "}
                            {pluralRu(unplayableTrackItems.length, [
                                "трек",
                                "трека",
                                "треков",
                            ])}
                            . {ru.playlist.unplayableHint}
                        </span>
                    </div>
                )}

                {trackItems.length > 0 || playlist.pendingTracks?.length > 0 ? (
                    <MusicDetailTrackSurface
                        label={`${playlist.name}: ${ru.playlist.tracks}`}
                    >
                        {/* Pending/failed tracks (custom inline - no playback, fundamentally different) */}
                        {(playlist.pendingTracks || []).map(
                            (pendingItem: PendingTrack) => {
                                const pending = pendingItem.pending;
                                const isPreviewPlaying =
                                    playingPreviewId === pending.id;
                                const isRetrying =
                                    retryingTrackId === pending.id;
                                const isRemoving =
                                    removingTrackId === pending.id;

                                return (
                                    <div
                                        key={`pending-${pending.id}`}
                                        className="group grid grid-cols-[44px_1fr_auto] gap-3 border-b border-white/[0.06] px-3 py-2 opacity-70 transition-opacity hover:opacity-100 motion-reduce:transition-none md:grid-cols-[44px_minmax(200px,2fr)_minmax(100px,1fr)_auto] md:px-4"
                                    >
                                        <div className="flex items-center justify-center">
                                            <AlertCircle className="w-4 h-4 text-red-400" />
                                        </div>
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-highlight">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        handlePlayPreview(
                                                            pending.id,
                                                        )
                                                    }
                                                    className="flex h-11 w-11 items-center justify-center transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-light motion-reduce:transition-none"
                                                    title={
                                                        ru.playlist.preview30
                                                    }
                                                    aria-label={
                                                        isPreviewPlaying
                                                            ? `Остановить фрагмент «${pending.title}»`
                                                            : `Воспроизвести фрагмент «${pending.title}»`
                                                    }
                                                >
                                                    {isPreviewPlaying ? (
                                                        <Volume2 className="w-5 h-5 text-brand animate-pulse" />
                                                    ) : (
                                                        <Play className="w-5 h-5 text-gray-400 hover:text-white" />
                                                    )}
                                                </button>
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium truncate text-gray-400">
                                                    {pending.title}
                                                </p>
                                                <p className="text-xs text-gray-400 truncate">
                                                    {pending.artist}
                                                </p>
                                            </div>
                                        </div>
                                        <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                            {pending.album}
                                        </p>
                                        <div className="flex items-center justify-end gap-1">
                                            <span className="text-xs text-red-400 mr-2 hidden sm:inline">
                                                {ru.playlist.failedDownload}
                                            </span>
                                            {downloadsEnabled && (
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleRetryPendingTrack(
                                                            pending.id,
                                                        );
                                                    }}
                                                    disabled={isRetrying}
                                                    className={cn(
                                                        "flex h-11 w-11 items-center justify-center rounded-full transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none",
                                                        isRetrying
                                                            ? "text-brand"
                                                            : "text-gray-400 hover:text-white",
                                                    )}
                                                    title={
                                                        ru.playlist
                                                            .retryDownload
                                                    }
                                                    aria-label={`Повторить загрузку «${pending.title}»`}
                                                >
                                                    {isRetrying ? (
                                                        <Loader2 className="w-4 h-4 animate-spin" />
                                                    ) : (
                                                        <RefreshCw className="w-4 h-4" />
                                                    )}
                                                </button>
                                            )}
                                            {playlist.isOwner && (
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleRemovePendingTrack(
                                                            pending.id,
                                                        );
                                                    }}
                                                    disabled={isRemoving}
                                                    className="flex h-11 w-11 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-white/10 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 motion-reduce:transition-none"
                                                    title={ru.playlist.remove}
                                                    aria-label={`Удалить недоступный трек «${pending.title}»`}
                                                >
                                                    {isRemoving ? (
                                                        <Loader2 className="w-4 h-4 animate-spin" />
                                                    ) : (
                                                        <X className="w-4 h-4" />
                                                    )}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            },
                        )}

                        {/* Regular tracks via shared TrackList */}
                        <SharedTrackList<PlaylistItem>
                            items={trackItems}
                            getKey={(item) => item.id}
                            reorder={
                                playlist.isOwner
                                    ? { onReorder: handleReorderByIndex }
                                    : undefined
                            }
                            toRowItem={(item) => ({
                                id: item.track?.id ?? item.id,
                                title:
                                    item.track?.title ||
                                    ru.playlist.unavailableTrack,
                                artistName:
                                    item.track?.album?.artist?.name ||
                                    ru.common.unknownArtist,
                                duration: item.track?.duration || 0,
                                coverArtUrl: item.track?.album?.coverArt
                                    ? api.getCoverArtUrl(
                                          item.track.album.coverArt,
                                          100,
                                      )
                                    : null,
                            })}
                            onPlay={(item) => {
                                if (isPlayableTrackItem(item)) {
                                    handlePlayTrack(item.id);
                                } else {
                                    // Cast needed: type guard narrows else branch to `never`
                                    const unplayable = item as PlaylistItem;
                                    toast.error(
                                        getUnplayableMessage(unplayable),
                                    );
                                }
                            }}
                            rowSlots={(item, index) => {
                                const track = item.track;
                                const isPlayable = isPlayableTrackItem(item);
                                const providerSource =
                                    item.provider?.source ||
                                    track?.streamSource ||
                                    "local";
                                const isRemoved =
                                    item.playback?.reason === "track_removed";
                                const fallbackMessage =
                                    getUnplayableMessage(item);
                                return {
                                    leadingColumn: isPlayable ? undefined : (
                                        <div className="flex items-center justify-center w-8">
                                            <span title={fallbackMessage}>
                                                <AlertCircle
                                                    className={cn(
                                                        "w-4 h-4",
                                                        isRemoved
                                                            ? "text-gray-400"
                                                            : "text-amber-300",
                                                    )}
                                                />
                                            </span>
                                        </div>
                                    ),
                                    titleBadges:
                                        track?.source === "federated" &&
                                        track.peer ? (
                                            <PeerBadge
                                                peerName={track.peer.name}
                                                online={track.peer.online}
                                            />
                                        ) : providerSource === "tidal" ? (
                                            <TidalBadge />
                                        ) : providerSource === "youtube" ? (
                                            <YouTubeBadge />
                                        ) : undefined,
                                    subtitleExtra: !isPlayable ? (
                                        <>
                                            <div className="mt-1 flex items-center gap-1.5">
                                                <UnplayableBadge
                                                    label={
                                                        isRemoved
                                                            ? "УДАЛЁН"
                                                            : item.playback
                                                                    ?.reason ===
                                                                "peer_offline"
                                                              ? "НЕ В СЕТИ"
                                                              : undefined
                                                    }
                                                    title={
                                                        isRemoved
                                                            ? TRACK_REMOVED_TOOLTIP
                                                            : undefined
                                                    }
                                                    variant={
                                                        isRemoved
                                                            ? "muted"
                                                            : "warning"
                                                    }
                                                />
                                            </div>
                                            <p
                                                className={cn(
                                                    "text-[11px] truncate mt-1",
                                                    isRemoved
                                                        ? "text-gray-400"
                                                        : "text-amber-200/90",
                                                )}
                                            >
                                                {fallbackMessage}
                                            </p>
                                        </>
                                    ) : undefined,
                                    middleColumns: (
                                        <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                            {track?.album?.title ||
                                                "Unavailable"}
                                        </p>
                                    ),
                                    trailingActions: (() => {
                                        const localTrackId =
                                            typeof item.trackId === "string" &&
                                            item.trackId.length > 0
                                                ? item.trackId
                                                : isLocalPlayableTrackItem(item)
                                                  ? track?.id || null
                                                  : null;
                                        const canShowLocalActions =
                                            Boolean(localTrackId) &&
                                            isLocalPlayableTrackItem(item);
                                        const isRemotePlayable =
                                            isPlayable &&
                                            !canShowLocalActions &&
                                            Boolean(track);
                                        const removeTargetId = item.id;
                                        const canShowFallbackRemoveAction =
                                            playlist.isOwner &&
                                            !canShowLocalActions &&
                                            !isRemotePlayable;

                                        const removeMenuItem =
                                            playlist.isOwner ? (
                                                <>
                                                    {index > 0 && (
                                                        <TrackMenuButton
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleMoveTrack(
                                                                    item.id,
                                                                    index - 1,
                                                                );
                                                            }}
                                                            icon={
                                                                <ArrowUp className="h-4 w-4" />
                                                            }
                                                            label={
                                                                ru.playlist
                                                                    .moveUp
                                                            }
                                                        />
                                                    )}
                                                    {index <
                                                        trackItems.length -
                                                            1 && (
                                                        <TrackMenuButton
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleMoveTrack(
                                                                    item.id,
                                                                    index + 1,
                                                                );
                                                            }}
                                                            icon={
                                                                <ArrowDown className="h-4 w-4" />
                                                            }
                                                            label={
                                                                ru.playlist
                                                                    .moveDown
                                                            }
                                                        />
                                                    )}
                                                    {index > 0 && (
                                                        <TrackMenuButton
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleMoveTrack(
                                                                    item.id,
                                                                    0,
                                                                );
                                                            }}
                                                            icon={
                                                                <ArrowUpToLine className="h-4 w-4" />
                                                            }
                                                            label={
                                                                ru.playlist
                                                                    .moveTop
                                                            }
                                                        />
                                                    )}
                                                    <TrackMenuButton
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRemoveTrack(
                                                                removeTargetId,
                                                            );
                                                        }}
                                                        icon={
                                                            <Trash2 className="h-4 w-4" />
                                                        }
                                                        label={
                                                            ru.playlist.remove
                                                        }
                                                        className="text-red-400 hover:text-red-300"
                                                    />
                                                </>
                                            ) : undefined;

                                        return (
                                            <div className="flex items-center justify-end gap-1">
                                                <span className="hidden sm:inline text-xs text-gray-400 w-10 text-right tabular-nums">
                                                    {track?.duration
                                                        ? formatTime(
                                                              track.duration,
                                                          )
                                                        : "--:--"}
                                                </span>
                                                {canShowLocalActions && (
                                                    <>
                                                        <TrackPreferenceButtons
                                                            trackId={
                                                                localTrackId!
                                                            }
                                                            mode="up-only"
                                                            buttonSizeClassName="h-11 w-11"
                                                            iconSizeClassName="h-4 w-4"
                                                        />
                                                        <TrackOverflowMenu
                                                            track={{
                                                                id: localTrackId!,
                                                                title:
                                                                    track?.title ||
                                                                    ru.playlist
                                                                        .unknownTitle,
                                                                artist: {
                                                                    name:
                                                                        track
                                                                            ?.album
                                                                            ?.artist
                                                                            ?.name ||
                                                                        ru
                                                                            .common
                                                                            .unknownArtist,
                                                                    id: track
                                                                        ?.album
                                                                        ?.artist
                                                                        ?.id,
                                                                },
                                                                album: {
                                                                    title:
                                                                        track
                                                                            ?.album
                                                                            ?.title ||
                                                                        ru
                                                                            .common
                                                                            .unknownAlbum,
                                                                    coverArt:
                                                                        track
                                                                            ?.album
                                                                            ?.coverArt ||
                                                                        undefined,
                                                                    id: track
                                                                        ?.album
                                                                        ?.id,
                                                                },
                                                                duration:
                                                                    track?.duration ||
                                                                    0,
                                                            }}
                                                            extraItemsAfter={
                                                                removeMenuItem
                                                            }
                                                        />
                                                    </>
                                                )}
                                                {isRemotePlayable && (
                                                    <>
                                                        <TrackPreferenceButtons
                                                            trackId={track!.id}
                                                            mode="up-only"
                                                            buttonSizeClassName="h-11 w-11"
                                                            iconSizeClassName="h-4 w-4"
                                                            metadata={buildPreferenceMetadata(
                                                                {
                                                                    id: track!
                                                                        .id,
                                                                    title: track!
                                                                        .title,
                                                                    artist: track!
                                                                        .album
                                                                        ?.artist,
                                                                    album: track!
                                                                        .album,
                                                                    duration:
                                                                        track!
                                                                            .duration,
                                                                },
                                                            )}
                                                        />
                                                        <TrackOverflowMenu
                                                            track={{
                                                                id: track!.id,
                                                                title:
                                                                    track!
                                                                        .title ||
                                                                    ru.playlist
                                                                        .unknownTitle,
                                                                artist: {
                                                                    name:
                                                                        track!
                                                                            .album
                                                                            ?.artist
                                                                            ?.name ||
                                                                        ru
                                                                            .common
                                                                            .unknownArtist,
                                                                    id: track!
                                                                        .album
                                                                        ?.artist
                                                                        ?.id,
                                                                },
                                                                album: {
                                                                    title:
                                                                        track!
                                                                            .album
                                                                            ?.title ||
                                                                        ru
                                                                            .common
                                                                            .unknownAlbum,
                                                                    coverArt:
                                                                        track!
                                                                            .album
                                                                            ?.coverArt ||
                                                                        undefined,
                                                                    id: track!
                                                                        .album
                                                                        ?.id,
                                                                },
                                                                duration:
                                                                    track!
                                                                        .duration ||
                                                                    0,
                                                                ...(track!
                                                                    .streamSource ===
                                                                "tidal"
                                                                    ? {
                                                                          streamSource:
                                                                              "tidal" as const,
                                                                          tidalTrackId:
                                                                              track!
                                                                                  .tidalTrackId,
                                                                      }
                                                                    : {}),
                                                                ...(track!
                                                                    .streamSource ===
                                                                "youtube"
                                                                    ? {
                                                                          streamSource:
                                                                              "youtube" as const,
                                                                          youtubeVideoId:
                                                                              track!
                                                                                  .youtubeVideoId,
                                                                      }
                                                                    : {}),
                                                            }}
                                                            showMatchVibe={
                                                                false
                                                            }
                                                            extraItemsAfter={
                                                                removeMenuItem
                                                            }
                                                        />
                                                    </>
                                                )}
                                                {canShowFallbackRemoveAction && (
                                                    <>
                                                        {index > 0 && (
                                                            <button
                                                                type="button"
                                                                onClick={(
                                                                    e,
                                                                ) => {
                                                                    e.stopPropagation();
                                                                    handleMoveTrack(
                                                                        item.id,
                                                                        index -
                                                                            1,
                                                                    );
                                                                }}
                                                                className="flex h-11 w-11 items-center justify-center rounded-full text-gray-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                                                title={
                                                                    ru.playlist
                                                                        .moveUp
                                                                }
                                                                aria-label={
                                                                    ru.playlist
                                                                        .moveUp
                                                                }
                                                            >
                                                                <ArrowUp className="h-4 w-4" />
                                                            </button>
                                                        )}
                                                        {index <
                                                            trackItems.length -
                                                                1 && (
                                                            <button
                                                                type="button"
                                                                onClick={(
                                                                    e,
                                                                ) => {
                                                                    e.stopPropagation();
                                                                    handleMoveTrack(
                                                                        item.id,
                                                                        index +
                                                                            1,
                                                                    );
                                                                }}
                                                                className="flex h-11 w-11 items-center justify-center rounded-full text-gray-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                                                title={
                                                                    ru.playlist
                                                                        .moveDown
                                                                }
                                                                aria-label={
                                                                    ru.playlist
                                                                        .moveDown
                                                                }
                                                            >
                                                                <ArrowDown className="h-4 w-4" />
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleRemoveTrack(
                                                                    removeTargetId,
                                                                );
                                                            }}
                                                            className="flex h-11 w-11 items-center justify-center rounded-full text-gray-400 transition-colors hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 motion-reduce:transition-none"
                                                            title={
                                                                ru.playlist
                                                                    .remove
                                                            }
                                                            aria-label={
                                                                ru.playlist
                                                                    .remove
                                                            }
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </button>
                                                    </>
                                                )}
                                                {!isPlayable && (
                                                    <span className="text-[11px] text-amber-200">
                                                        {ru.playlist.cannotPlay}
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })(),
                                    rowClassName: cn(
                                        isRemoved &&
                                            "bg-white/[0.02] hover:bg-white/[0.04] opacity-60 cursor-not-allowed",
                                        !isPlayable &&
                                            !isRemoved &&
                                            "bg-amber-500/[0.06] hover:bg-amber-500/[0.1] cursor-not-allowed",
                                    ),
                                };
                            }}
                            rowClassName="grid-cols-[28px_1fr_auto] md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto]"
                            preferenceMode={null}
                            header={
                                <TrackListHeader
                                    className="grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto] gap-4 mb-2"
                                    columns={[
                                        {
                                            label: "#",
                                            className: "text-center",
                                        },
                                        {
                                            label: ru.playlist.titleColumn,
                                        },
                                        {
                                            label: ru.playlist.albumColumn,
                                        },
                                        { label: "" },
                                    ]}
                                />
                            }
                        />
                    </MusicDetailTrackSurface>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-20 h-20 bg-surface-highlight rounded-full flex items-center justify-center mb-4">
                            <ListMusic className="w-10 h-10 text-gray-400" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-1">
                            {ru.playlist.noTracks}
                        </h3>
                        <p className="text-sm text-gray-400">
                            {ru.playlist.addTracksHint}
                        </p>
                    </div>
                )}
            </div>

            {/* Confirm Dialog */}
            <ConfirmDialog
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={handleDeletePlaylist}
                title={ru.playlist.deleteQuestion}
                message={`Удалить «${playlist.name}»? ${ru.playlist.deleteWarning}`}
                confirmText={ru.common.delete}
                cancelText={ru.common.cancel}
                variant="danger"
            />

            <ShareLinkModal
                isOpen={showShareModal}
                onClose={() => setShowShareModal(false)}
                resourceType="playlist"
                resourceId={playlistId}
                resourceName={playlist.name}
            />
        </div>
    );
}
