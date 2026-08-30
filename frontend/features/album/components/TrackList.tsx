import React, { memo, useCallback, useMemo } from "react";
import { Play, Pause, Volume2, Disc } from "lucide-react";
import { cn } from "@/utils/cn";
import type { Track, Album, AlbumSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatTime } from "@/utils/formatTime";
import { formatNumber } from "@/utils/formatNumber";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { PeerBadge } from "@/components/ui/PeerBadge";
import {
    TrackList as SharedTrackList,
    PreviewBadge,
    LoadingBadge,
} from "@/components/track";
import type { TrackRowItem, TrackRowSlots, RowState } from "@/components/track";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { isAlbumTrackPlayable } from "../albumPlayback";
import { MusicDetailTrackSurface } from "@/components/music-detail";

interface TrackListProps {
    tracks: Track[];
    album: Album;
    source: AlbumSource;
    currentTrackId: string | undefined;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track, index: number) => void;
    previewTrack: string | null;
    previewPlaying: boolean;
    onPreview: (track: Track, e: React.MouseEvent) => void;
    isProviderMatching?: boolean;
    /** Track id to visually highlight (e.g. from a ?track= deep link). */
    highlightTrackId?: string | null;
}

export const TrackList = memo(function TrackList({
    tracks,
    album,
    source,
    currentTrackId: _currentTrackId,
    colors,
    onPlayTrack,
    previewTrack,
    previewPlaying,
    onPreview,
    isProviderMatching = false,
    highlightTrackId = null,
}: TrackListProps) {
    const isMultiDisc = useMemo(() => {
        if (!tracks?.length) return false;
        const discs = new Set(tracks.map((t) => t.discNumber ?? t.discNo ?? 1));
        return discs.size > 1;
    }, [tracks]);

    const toRowItem = useCallback(
        (track: Track): TrackRowItem => ({
            id: track.id,
            title: track.title,
            displayTitle: track.displayTitle,
            artistName: track.artist?.name ?? album.artist?.name ?? "",
            duration: track.duration,
            coverArtUrl: null, // Album page doesn't show per-row cover art
            isPlayable: isAlbumTrackPlayable(track, source),
            unplayableReason:
                track.source === "federated" && track.peer?.online === false
                    ? "peer_offline"
                    : undefined,
        }),
        [album.artist?.name, source],
    );

    const handlePlay = useCallback(
        (track: Track, index: number) => {
            const isYouTubeTrack = track.streamSource === "youtube";
            const isTidalTrack =
                track.streamSource === "tidal" && !!track.tidalTrackId;
            const hasLocalFile =
                typeof track.filePath === "string" &&
                track.filePath.trim().length > 0;
            const isAwaitingProviderMatch =
                isProviderMatching &&
                !hasLocalFile &&
                !isTidalTrack &&
                !isYouTubeTrack;
            const isPlayable = isAlbumTrackPlayable(track, source);
            const isPreviewOnly = !isPlayable && !isAwaitingProviderMatch;

            if (isAwaitingProviderMatch) return;
            if (isPreviewOnly) {
                onPreview(track, {
                    stopPropagation: () => {},
                } as React.MouseEvent);
                return;
            }
            onPlayTrack(track, index);
        },
        [isProviderMatching, onPlayTrack, onPreview, source],
    );

    const rowSlots = useCallback(
        (track: Track, index: number, state: RowState): TrackRowSlots => {
            const isYouTubeTrack = track.streamSource === "youtube";
            const isTidalTrack =
                track.streamSource === "tidal" && !!track.tidalTrackId;
            const isFederated = track.source === "federated";
            const hasLocalFile =
                typeof track.filePath === "string" &&
                track.filePath.trim().length > 0;
            const isAwaitingProviderMatch =
                isProviderMatching &&
                !hasLocalFile &&
                !isTidalTrack &&
                !isYouTubeTrack;
            const isPlayable = isAlbumTrackPlayable(track, source);
            const isPreviewOnly = !isPlayable && !isAwaitingProviderMatch;
            const isPreviewPlaying =
                previewTrack === track.id && previewPlaying;

            return {
                leadingColumn: (
                    <div className="w-6 md:w-8 flex-shrink-0 text-center">
                        <span
                            className={cn(
                                "group-hover:hidden text-sm",
                                state.isPlaying
                                    ? "text-ai-hover font-bold"
                                    : "text-gray-400",
                            )}
                        >
                            {track.trackNumber ||
                                track.trackNo ||
                                track.displayTrackNo ||
                                index + 1}
                        </span>
                        <Play
                            className="hidden group-hover:inline-block w-4 h-4 text-white"
                            fill="currentColor"
                        />
                    </div>
                ),
                titleBadges: (
                    <>
                        {isTidalTrack && <TidalBadge />}
                        {isYouTubeTrack && <YouTubeBadge />}
                        {isFederated && track.peer && (
                            <PeerBadge
                                peerName={track.peer.name}
                                online={track.peer.online}
                            />
                        )}
                        {isAwaitingProviderMatch && <LoadingBadge />}
                        {isPreviewOnly && <PreviewBadge />}
                    </>
                ),
                artistContent:
                    track.artist?.name &&
                    track.artist.name !== album.artist?.name ? (
                        <div className="text-xs md:text-sm text-gray-400 truncate">
                            {track.artist.name}
                        </div>
                    ) : null,
                trailingActions: (
                    <div
                        className="flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        role="group"
                        aria-label={`Действия с треком «${track.displayTitle ?? track.title}»`}
                    >
                        {isPlayable &&
                            track.playCount !== undefined &&
                            track.playCount > 0 && (
                                <div className="hidden lg:flex items-center gap-1.5 text-xs text-gray-400 bg-surface-hover px-2 py-1 rounded-full">
                                    <Play className="w-3 h-3" />
                                    <span>{formatNumber(track.playCount)}</span>
                                </div>
                            )}
                        {isPreviewOnly && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onPreview(track, e);
                                }}
                                className="p-2 rounded-full bg-surface-hover hover:bg-[#2a2a2a] transition-colors text-white"
                                aria-label={
                                    isPreviewPlaying
                                        ? "Поставить фрагмент на паузу"
                                        : "Воспроизвести фрагмент"
                                }
                            >
                                {isPreviewPlaying ? (
                                    <Pause className="w-4 h-4" />
                                ) : (
                                    <Volume2 className="w-4 h-4" />
                                )}
                            </button>
                        )}
                        <span className="hidden w-10 text-right text-xs tabular-nums text-gray-400 sm:inline">
                            {track.duration ? formatTime(track.duration) : ""}
                        </span>
                        <TrackPreferenceButtons
                            trackId={track.id}
                            mode="both"
                            buttonSizeClassName="h-11 w-11"
                            iconSizeClassName="h-4 w-4"
                            metadata={buildPreferenceMetadata(track)}
                        />
                        {isPlayable && (
                            <TrackOverflowMenu
                                track={{
                                    id: track.id,
                                    title: track.displayTitle ?? track.title,
                                    artist: {
                                        name:
                                            track.artist?.name ??
                                            album.artist?.name ??
                                            "",
                                        id:
                                            track.artist?.id ??
                                            album.artist?.id,
                                    },
                                    album: {
                                        title: album.title,
                                        coverArt: album.coverArt,
                                        id: album.id,
                                    },
                                    duration: track.duration ?? 0,
                                    streamSource:
                                        track.streamSource === "tidal" ||
                                        track.streamSource === "youtube"
                                            ? track.streamSource
                                            : undefined,
                                }}
                                showGoToAlbum={false}
                            />
                        )}
                    </div>
                ),
                rowClassName: cn(
                    state.isPlaying && "bg-surface-hover border-l-2",
                    isPreviewOnly && "opacity-70 hover:opacity-90",
                    isFederated && !track.peer?.online && "opacity-50",
                    highlightTrackId === track.id &&
                        "bg-brand/[0.12] ring-1 ring-inset ring-brand/50",
                ),
            };
        },
        [
            album,
            isProviderMatching,
            previewTrack,
            previewPlaying,
            onPreview,
            highlightTrackId,
            source,
        ],
    );

    const separator = useCallback(
        (track: Track, index: number, prevTrack: Track | null) => {
            if (!isMultiDisc) return null;
            const currentDisc = track.discNumber ?? track.discNo ?? 1;
            const prevDisc = prevTrack
                ? (prevTrack.discNumber ?? prevTrack.discNo ?? 1)
                : 0;
            if (index === 0 || currentDisc !== prevDisc) {
                return (
                    <div className="flex items-center gap-2 px-3 md:px-4 py-2.5 bg-[#0d0d0d] border-b border-surface-active">
                        <Disc className="w-3.5 h-3.5 text-gray-400" />
                        <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                            Диск {currentDisc}
                        </span>
                    </div>
                );
            }
            return null;
        },
        [isMultiDisc],
    );

    return (
        <MusicDetailTrackSurface label={`${album.title}: треки`}>
            <SharedTrackList<Track>
                items={tracks}
                toRowItem={toRowItem}
                onPlay={handlePlay}
                rowSlots={rowSlots}
                separator={separator}
                showCoverArt={false}
                rowClassName="grid-cols-[28px_minmax(0,1fr)_auto] sm:grid-cols-[40px_minmax(0,1fr)_auto]"
                accentColor={colors?.vibrant || "var(--music-action)"}
                tvSection="tracks"
                className="divide-y divide-white/[0.06]"
            />
        </MusicDetailTrackSurface>
    );
});
