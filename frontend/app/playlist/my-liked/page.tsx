"use client";

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Heart,
    ListMusic,
    Loader2,
    Music,
    Pause,
    Play,
    Plus,
    Radio,
    Shuffle,
} from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import {
    useAudioControls,
    useAudioState,
    usePlaybackStatus,
} from "@/lib/audio-context";
import {
    api,
    type LikedPlaylistResponse,
    type LikedPlaylistTrack,
} from "@/lib/api";
import { queryKeys, useLikedPlaylistQuery } from "@/hooks/useQueries";
import { formatTime } from "@/utils/formatTime";
import { shuffleArray } from "@/utils/shuffle";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { useToast } from "@/lib/toast-context";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { toAudioTrack } from "./likedPlaylistUtils";
import { TrackList, TrackListHeader } from "@/components/track";
import type { TrackRowItem, TrackRowSlots } from "@/components/track";
import { DeviceCollectionDownloadButton } from "@/features/device-offline/components/DeviceCollectionDownloadButton";
import { isLikedPlaylistTrackDownloadable } from "@/features/device-offline/likedAutomation";
import {
    MusicDetailActionDock,
    MusicDetailHero,
    MusicDetailTrackSurface,
} from "@/components/music-detail";
import { pluralRu, ru } from "@/lib/i18n/ru";

const EMPTY_TRACKS: LikedPlaylistTrack[] = [];

/**
 * Resolves the best cover-art URL for a liked track by provider.
 */
export function resolveLikedTrackCoverUrl(
    track: LikedPlaylistTrack,
    size: number,
): string | null {
    if (!track.album.coverArt) {
        return null;
    }
    if (track.streamSource === "tidal") {
        return api.getTidalBrowseImageUrl(track.album.coverArt);
    }
    if (track.streamSource === "youtube") {
        return api.getBrowseImageUrl(track.album.coverArt);
    }
    return api.getCoverArtUrl(track.album.coverArt, size);
}

function toRowItem(track: LikedPlaylistTrack): TrackRowItem {
    const rawTidalTrackId = track.tidalTrackId ?? track.provider?.tidalTrackId;
    const tidalTrackId =
        typeof rawTidalTrackId === "number"
            ? rawTidalTrackId
            : typeof rawTidalTrackId === "string" &&
                /^\d+$/.test(rawTidalTrackId)
              ? Number(rawTidalTrackId)
              : undefined;
    return {
        id: track.id,
        title: track.title,
        artistName: track.artist.name,
        duration: track.duration,
        streamSource:
            track.streamSource === "tidal" || track.streamSource === "youtube"
                ? track.streamSource
                : undefined,
        tidalTrackId,
        youtubeVideoId:
            track.youtubeVideoId ?? track.provider?.youtubeVideoId ?? undefined,
        coverArtUrl: resolveLikedTrackCoverUrl(track, 100),
    };
}

interface LikedTrackListProps {
    tracks: LikedPlaylistTrack[];
    likedTrackIds: Set<string>;
    removingTrackId: string | null;
    onPlay: (track: LikedPlaylistTrack) => void;
    onUnlike: (trackId: string) => void;
}

function LikedTrackList({
    tracks,
    likedTrackIds,
    removingTrackId,
    onPlay,
    onUnlike,
}: LikedTrackListProps) {
    const handlePlay = useCallback(
        (track: LikedPlaylistTrack) => onPlay(track),
        [onPlay],
    );

    const rowSlots = useCallback(
        (track: LikedPlaylistTrack): TrackRowSlots => {
            const isRemote =
                track.streamSource === "youtube" ||
                track.streamSource === "tidal";
            return {
                titleBadges: isRemote ? (
                    <>
                        {track.streamSource === "tidal" ? (
                            <TidalBadge />
                        ) : (
                            <YouTubeBadge />
                        )}
                    </>
                ) : undefined,
                middleColumns: (
                    <p className="hidden truncate text-sm text-gray-400 md:flex items-center">
                        {track.album.title}
                    </p>
                ),
                trailingActions: (
                    <div className="flex items-center justify-end gap-1">
                        <span className="hidden sm:inline text-xs text-gray-400 w-10 text-right tabular-nums">
                            {formatTime(track.duration)}
                        </span>
                        <TrackPreferenceButtons
                            trackId={track.id}
                            mode="up-only"
                            resolveFromQuery={false}
                            signal={
                                likedTrackIds.has(track.id)
                                    ? "thumbs_up"
                                    : "clear"
                            }
                            isSaving={removingTrackId === track.id}
                            onToggleThumbsUp={() => onUnlike(track.id)}
                            buttonSizeClassName="h-11 w-11"
                            iconSizeClassName="h-4 w-4"
                        />
                        <TrackOverflowMenu
                            track={toAudioTrack(track)}
                            showGoToAlbum={!isRemote}
                            showMatchVibe={!isRemote}
                        />
                    </div>
                ),
            };
        },
        [likedTrackIds, removingTrackId, onUnlike],
    );

    return (
        <div className="w-full">
            <TrackList
                items={tracks}
                toRowItem={toRowItem}
                onPlay={handlePlay}
                rowSlots={rowSlots}
                rowClassName="grid-cols-[28px_1fr_auto] md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto]"
                accentColor="var(--music-action)"
                preferenceMode={null}
                header={
                    <TrackListHeader
                        className="grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto] gap-4 mb-2"
                        columns={[
                            { label: "#", className: "text-center" },
                            { label: ru.playlist.titleColumn },
                            { label: ru.playlist.albumColumn },
                            { label: "" },
                        ]}
                    />
                }
            />
        </div>
    );
}

/**
 * Renders the MyLikedPlaylistPage component.
 */
export default function MyLikedPlaylistPage() {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { currentTrack } = useAudioState();
    // Narrow subscription: this page only reads isPlaying, so it must not
    // re-render on the once-per-second currentTime tick (GH #784).
    const { isPlaying } = usePlaybackStatus();
    const { playTracks, playNow, pause, resume, addTracksToQueue } =
        useAudioControls();
    const { data, isLoading, isError } = useLikedPlaylistQuery();
    const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [isAddingToPlaylist, setIsAddingToPlaylist] = useState(false);
    const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
        usePlayButtonFeedback();

    const likedTracks = data?.tracks ?? EMPTY_TRACKS;
    const likedTrackIds = useMemo(
        () => new Set(likedTracks.map((track) => track.id)),
        [likedTracks],
    );
    const audioTracks = useMemo(
        () => likedTracks.map((track) => toAudioTrack(track)),
        [likedTracks],
    );
    const deviceDownloadTracks = useMemo(
        () =>
            likedTracks
                .filter((track) => isLikedPlaylistTrackDownloadable(track))
                .map((track) => toAudioTrack(track)),
        [likedTracks],
    );
    const totalDuration = useMemo(
        () =>
            likedTracks.reduce((sum, track) => sum + (track.duration || 0), 0),
        [likedTracks],
    );
    const isThisPlaylistPlaying = useMemo(() => {
        if (!currentTrack || !isPlaying || likedTracks.length === 0) {
            return false;
        }
        return likedTrackIds.has(currentTrack.id);
    }, [currentTrack, isPlaying, likedTracks.length, likedTrackIds]);

    const coverUrl = useMemo(() => {
        if (likedTracks.length === 0) return null;
        return resolveLikedTrackCoverUrl(likedTracks[0], 200);
    }, [likedTracks]);

    const unlikeMutation = useMutation({
        mutationFn: (trackId: string) =>
            api.setTrackPreference(trackId, "clear"),
        onMutate: async (trackId: string) => {
            setRemovingTrackId(trackId);
            await queryClient.cancelQueries({
                queryKey: queryKeys.likedPlaylist(),
            });
            const previous = queryClient.getQueryData<LikedPlaylistResponse>(
                queryKeys.likedPlaylist(),
            );

            queryClient.setQueryData<LikedPlaylistResponse>(
                queryKeys.likedPlaylist(),
                (old) => {
                    if (!old) return old;
                    const nextTracks = old.tracks.filter(
                        (track) => track.id !== trackId,
                    );
                    if (nextTracks.length === old.tracks.length) return old;
                    return {
                        ...old,
                        tracks: nextTracks,
                        total: Math.max(0, old.total - 1),
                    };
                },
            );

            return { previous };
        },
        onError: (_error, _trackId, context) => {
            if (context?.previous) {
                queryClient.setQueryData(
                    queryKeys.likedPlaylist(),
                    context.previous,
                );
            }
            toast.error(ru.playlist.likeUpdateFailed);
        },
        onSuccess: (preference) => {
            queryClient.setQueryData(
                ["track-preference", preference.trackId],
                preference,
            );
            toast.success(ru.playlist.removedLiked);
        },
        onSettled: () => {
            setRemovingTrackId(null);
            queryClient.invalidateQueries({
                queryKey: queryKeys.likedPlaylistAll(),
            });
        },
    });

    const formatTotalDuration = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `${hours} ч ${mins} мин`;
        }
        return `${mins} мин`;
    };

    const handleAddAllToQueue = () => {
        if (audioTracks.length === 0) return;
        addTracksToQueue(audioTracks);
        toast.success(
            `${ru.playlist.addedToQueue}: ${audioTracks.length} ${pluralRu(audioTracks.length, ["трек", "трека", "треков"])}`,
        );
    };

    const handlePlaylistSelected = async (playlistId: string) => {
        if (likedTracks.length === 0) return;
        setIsAddingToPlaylist(true);
        try {
            for (const track of likedTracks) {
                await api.addTrackToPlaylist(
                    playlistId,
                    toAddToPlaylistRef({
                        id: track.id,
                        title: track.title,
                        artist: track.artist?.name,
                        album: track.album?.title,
                        duration: track.duration,
                        streamSource: track.streamSource,
                        youtubeVideoId: track.youtubeVideoId,
                        tidalTrackId: track.tidalTrackId,
                        thumbnailUrl: track.album?.coverArt || undefined,
                    }),
                );
            }
            toast.success(
                `Добавлено в плейлист: ${likedTracks.length} ${pluralRu(likedTracks.length, ["трек", "трека", "треков"])}`,
            );
        } catch (error) {
            sharedFrontendLogger.error(
                "Failed to add tracks to playlist:",
                error,
            );
            toast.error(ru.playlist.addSomeFailed);
            throw error;
        } finally {
            setIsAddingToPlaylist(false);
        }
    };

    const handlePlayAll = () => {
        if (audioTracks.length === 0) return;
        if (isThisPlaylistPlaying) {
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
            return;
        }
        triggerPlayFeedback();
        playTracks(audioTracks, 0);
    };

    const handleShuffle = () => {
        if (audioTracks.length < 2) return;
        playTracks(shuffleArray(audioTracks), 0);
    };

    const handlePlayTrack = (track: LikedPlaylistTrack) => {
        playNow(toAudioTrack(track));
    };

    const handleStartRadio = async () => {
        if (!data?.playlist.id) return;
        try {
            toast.info(ru.playlist.startingRadio);
            const response = await api.getRadioTracks(
                "playlist",
                data.playlist.id,
            );
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
            <div className="flex min-h-screen items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-white/60" />
            </div>
        );
    }

    if (isError || !data) {
        return (
            <div className="flex min-h-screen items-center justify-center px-6 text-center">
                <p className="text-sm text-white/60">
                    Сейчас не удалось загрузить любимые треки.
                </p>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            <MusicDetailHero
                eyebrow={ru.playlist.playlist}
                title={ru.library.likedSongs}
                artworkShape="square"
                backgroundImage={coverUrl}
                metadata={
                    <>
                        <span>
                            {likedTracks.length}{" "}
                            {pluralRu(likedTracks.length, [
                                "трек",
                                "трека",
                                "треков",
                            ])}
                        </span>
                        {totalDuration > 0 && (
                            <>
                                <span aria-hidden="true">•</span>
                                <span>
                                    {formatTotalDuration(totalDuration)}
                                </span>
                            </>
                        )}
                        <span aria-hidden="true">•</span>
                        <span>{ru.playlist.savedToAccount}</span>
                    </>
                }
                artwork={
                    <>
                        {coverUrl ? (
                            <CachedImage
                                src={coverUrl}
                                alt={ru.nav.liked}
                                fill
                                className="object-cover"
                                sizes="(max-width: 640px) 176px, 224px"
                            />
                        ) : (
                            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand/25 via-ai/10 to-surface-highlight">
                                <Heart className="h-16 w-16 text-brand-hover" />
                            </div>
                        )}
                        <div className="absolute bottom-3 right-3 grid h-11 w-11 place-items-center rounded-full bg-black/55 text-pink-400 shadow-lg backdrop-blur-md">
                            <Heart
                                className="h-6 w-6 fill-current"
                                strokeWidth={2.5}
                            />
                        </div>
                    </>
                }
                actions={
                    likedTracks.length > 0 ? (
                        <MusicDetailActionDock
                            label={ru.playlist.likedControls}
                        >
                            <div
                                data-detail-action-tier="primary"
                                className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none"
                            >
                                <button
                                    onClick={handlePlayAll}
                                    className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-brand-hover px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition-transform hover:scale-[1.02] active:scale-[0.98] motion-reduce:transition-none sm:flex-none"
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
                                {likedTracks.length > 1 && (
                                    <button
                                        onClick={handleShuffle}
                                        className="flex h-11 w-11 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
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
                                <DeviceCollectionDownloadButton
                                    tracks={deviceDownloadTracks}
                                    collectionId="playlist:my-liked"
                                    collectionLabel={ru.library.likedSongs}
                                />
                                <button
                                    onClick={handleAddAllToQueue}
                                    className="flex h-11 w-11 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                    title={ru.playlist.addAllQueue}
                                    aria-label={ru.playlist.addAllQueue}
                                >
                                    <ListMusic className="h-5 w-5" />
                                </button>
                                <button
                                    onClick={() =>
                                        setShowPlaylistSelector(true)
                                    }
                                    className="flex h-11 w-11 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                    title={ru.playlist.addAllPlaylist}
                                    aria-label={ru.playlist.addAllPlaylist}
                                >
                                    <Plus className="h-5 w-5" />
                                </button>
                                <button
                                    onClick={handleStartRadio}
                                    className="flex h-11 w-11 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                                    title={ru.playlist.startRadio}
                                    aria-label={ru.playlist.startRadio}
                                >
                                    <Radio className="h-5 w-5" />
                                </button>
                            </div>
                        </MusicDetailActionDock>
                    ) : undefined
                }
            />

            {/* Track List */}
            <div className="mx-auto max-w-[1800px] px-4 pt-2 sm:px-6 lg:px-8">
                {likedTracks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/5">
                            <Music className="h-8 w-8 text-white/40" />
                        </div>
                        <h2 className="mb-1 text-lg font-semibold text-white">
                            Любимых треков пока нет
                        </h2>
                        <p className="text-sm text-white/50">
                            Нажмите на сердечко рядом с треком, чтобы добавить
                            его сюда.
                        </p>
                    </div>
                ) : (
                    <MusicDetailTrackSurface label={ru.playlist.likedTracks}>
                        <LikedTrackList
                            tracks={likedTracks}
                            likedTrackIds={likedTrackIds}
                            removingTrackId={removingTrackId}
                            onPlay={handlePlayTrack}
                            onUnlike={(trackId) =>
                                unlikeMutation.mutate(trackId)
                            }
                        />
                    </MusicDetailTrackSurface>
                )}
            </div>

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => setShowPlaylistSelector(false)}
                onSelectPlaylist={handlePlaylistSelected}
                isLoading={isAddingToPlaylist}
                loadingMessage={ru.playlist.addingTracks}
            />
        </div>
    );
}
