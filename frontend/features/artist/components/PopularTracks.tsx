import React, { useCallback, useMemo, useState } from "react";
import { Play, Plus, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Track, Artist } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatTime } from "@/utils/formatTime";
import { formatNumber } from "@/utils/formatNumber";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { PeerBadge } from "@/components/ui/PeerBadge";
import { TrackList, LoadingBadge } from "@/components/track";
import type { TrackRowItem, TrackRowSlots, RowState } from "@/components/track";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { resolvePreferenceTrackId } from "@/lib/trackRef";
import { useTrackAlbumResolutions } from "../hooks/useTrackAlbumResolutions";
import { MusicDetailTrackSurface } from "@/components/music-detail";

/** Default number of popular tracks shown in collapsed state. */
export const POPULAR_COLLAPSED_COUNT = 5;

interface PopularTracksProps {
    tracks: Track[];
    artist: Artist;
    currentTrackId: string | undefined;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track, index: number, visibleTracks: Track[]) => void;
    isProviderMatching?: boolean;
    popularHref?: string;
    onAddAllToQueue?: (visibleTracks: Track[]) => void;
    showAll?: boolean;
}

function toRowItem(track: Track): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        artistName: track.artist?.name ?? "",
        duration: track.duration,
        coverArtUrl: track.album?.coverArt
            ? api.getCoverArtUrl(track.album.coverArt, 80)
            : null,
        isPlayable: track.source !== "federated" || track.peer?.online === true,
        unplayableReason:
            track.source === "federated" && track.peer?.online === false
                ? "peer_offline"
                : undefined,
    };
}

export const PopularTracks: React.FC<PopularTracksProps> = ({
    tracks,
    artist,
    currentTrackId: _currentTrackId,
    colors: _colors,
    onPlayTrack,
    isProviderMatching = false,
    popularHref,
    onAddAllToQueue,
    showAll = false,
}) => {
    const [expanded, setExpanded] = useState(false);
    const canExpand = tracks.length > POPULAR_COLLAPSED_COUNT;
    const visibleTracks = useMemo(
        () =>
            showAll || expanded
                ? tracks
                : tracks.slice(0, POPULAR_COLLAPSED_COUNT),
        [tracks, expanded, showAll],
    );
    const albumResolutions = useTrackAlbumResolutions(
        visibleTracks,
        artist.name,
    );

    const handlePlay = useCallback(
        (track: Track, index: number) => {
            const isYtMusic =
                track.streamSource === "youtube" && !!track.youtubeVideoId;
            const isTidalTrack =
                track.streamSource === "tidal" && !!track.tidalTrackId;
            const hasLocalFile =
                typeof track.filePath === "string" &&
                track.filePath.trim().length > 0;
            const isPlayable =
                (track.source === "federated" && track.peer?.online === true) ||
                hasLocalFile ||
                isTidalTrack ||
                isYtMusic;

            if (!isPlayable) return;
            onPlayTrack(track, index, visibleTracks);
        },
        [onPlayTrack, visibleTracks],
    );

    const rowSlots = useCallback(
        (track: Track, _index: number, _state: RowState): TrackRowSlots => {
            const isYtMusic =
                track.streamSource === "youtube" && !!track.youtubeVideoId;
            const isTidalTrack =
                track.streamSource === "tidal" && !!track.tidalTrackId;
            const hasLocalFile =
                typeof track.filePath === "string" &&
                track.filePath.trim().length > 0;
            const isPlayable =
                (track.source === "federated" && track.peer?.online === true) ||
                hasLocalFile ||
                isTidalTrack ||
                isYtMusic;
            const isUnowned =
                !track.album?.id ||
                !track.album?.title ||
                track.album.title === "Unknown Album";
            const isAwaitingProviderMatch =
                isProviderMatching &&
                isUnowned &&
                !hasLocalFile &&
                !isTidalTrack &&
                !isYtMusic;

            const preferenceTrackId = resolvePreferenceTrackId({
                ...track,
                hasLocalFile,
            });

            const resolution = track.album?.id
                ? undefined
                : albumResolutions.get(track.id);
            const albumId = track.album?.id || resolution?.rgMbid;
            const localAlbumTitle =
                track.album?.title && track.album.title !== "Unknown Album"
                    ? track.album.title
                    : undefined;
            const albumTitle = localAlbumTitle ?? resolution?.albumTitle;
            const albumHref = albumId ? `/album/${albumId}` : null;

            return {
                titleBadges: (
                    <>
                        {isTidalTrack && <TidalBadge />}
                        {isYtMusic && <YouTubeBadge />}
                        {track.source === "federated" && track.peer && (
                            <PeerBadge
                                peerName={track.peer.name}
                                online={track.peer.online}
                            />
                        )}
                        {isAwaitingProviderMatch && <LoadingBadge />}
                    </>
                ),
                middleColumns: (
                    <div className="hidden md:flex items-center gap-3 min-w-0 text-sm text-gray-400">
                        {albumTitle &&
                            (albumHref ? (
                                <Link
                                    href={albumHref}
                                    onClick={(e) => e.stopPropagation()}
                                    className="truncate hover:text-white hover:underline"
                                    title={albumTitle}
                                >
                                    {albumTitle}
                                </Link>
                            ) : (
                                <span className="truncate" title={albumTitle}>
                                    {albumTitle}
                                </span>
                            ))}
                        {track.playCount !== undefined &&
                            track.playCount > 0 && (
                                <span className="flex shrink-0 items-center gap-1">
                                    <Play className="w-3 h-3" />
                                    {formatNumber(track.playCount)}
                                </span>
                            )}
                    </div>
                ),
                trailingActions: (
                    <div
                        className="flex items-center justify-end gap-1"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        role="group"
                        aria-label={`Действия с треком «${track.displayTitle ?? track.title}»`}
                    >
                        {track.duration > 0 && (
                            <span className="hidden w-10 text-right text-xs tabular-nums text-gray-400 sm:inline">
                                {formatTime(track.duration)}
                            </span>
                        )}
                        <TrackPreferenceButtons
                            trackId={preferenceTrackId}
                            mode="both"
                            buttonSizeClassName="h-11 w-11"
                            iconSizeClassName="h-4 w-4"
                            metadata={buildPreferenceMetadata({
                                ...track,
                                id: preferenceTrackId,
                            })}
                        />
                        <TrackOverflowMenu
                            triggerClassName="h-11 w-11 p-0"
                            track={{
                                id: track.id,
                                title: track.displayTitle ?? track.title,
                                artist: {
                                    name: track.artist?.name ?? artist.name,
                                    id: track.artist?.id ?? artist.id,
                                },
                                album: {
                                    title: albumTitle ?? "",
                                    id: albumId || undefined,
                                    coverArt: track.album?.coverArt,
                                },
                                duration: track.duration,
                                streamSource:
                                    track.streamSource === "tidal" ||
                                    track.streamSource === "youtube"
                                        ? track.streamSource
                                        : undefined,
                                tidalTrackId: track.tidalTrackId,
                                youtubeVideoId: track.youtubeVideoId,
                                source: track.source,
                                peer: track.peer,
                            }}
                            showPlayNext={isPlayable}
                            showAddToQueue={isPlayable}
                            showAddToPlaylist={isPlayable}
                            showMatchVibe={isPlayable}
                            showVibeMap={isPlayable}
                        />
                    </div>
                ),
                rowClassName:
                    !isPlayable && !isAwaitingProviderMatch
                        ? "opacity-50"
                        : undefined,
            };
        },
        [artist, isProviderMatching, albumResolutions],
    );

    return (
        <section
            id="popular"
            className="scroll-mt-28"
            data-artist-tracks-canvas="open"
        >
            <div className="mb-5 flex items-end justify-between gap-3">
                <div className="min-w-0">
                    <p className="mb-1 text-[0.6875rem] font-bold uppercase tracking-[0.18em] text-content-muted">
                        Каталог исполнителя
                    </p>
                    <h2 className="text-2xl font-black tracking-[-0.03em] sm:text-3xl">
                        {popularHref ? (
                            <Link
                                href={popularHref}
                                className="inline-flex min-h-11 items-center rounded-lg py-1 transition-colors hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                            >
                                Популярные треки
                            </Link>
                        ) : (
                            "Популярные треки"
                        )}
                    </h2>
                    <p className="mt-1 text-sm text-content-secondary">
                        После выбранного трека очередь продолжится в показанном
                        порядке.
                    </p>
                </div>
                {onAddAllToQueue && (
                    <button
                        onClick={() => onAddAllToQueue(visibleTracks)}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        title="Добавить показанные популярные треки в очередь"
                        aria-label="Добавить показанные популярные треки в очередь"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                )}
            </div>
            <MusicDetailTrackSurface
                label={`Треки исполнителя ${artist.name}`}
                className="rounded-none border-x-0 bg-transparent shadow-none"
            >
                <TrackList
                    items={visibleTracks}
                    toRowItem={toRowItem}
                    onPlay={handlePlay}
                    rowSlots={rowSlots}
                    rowClassName="grid-cols-[32px_minmax(0,1fr)_auto] sm:grid-cols-[40px_minmax(0,1fr)_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(80px,1fr)_auto]"
                    preferenceMode="both"
                    tvSection="tracks"
                    className="divide-y divide-white/[0.06]"
                />
            </MusicDetailTrackSurface>
            {canExpand && !showAll && (
                <button
                    onClick={() => setExpanded((prev) => !prev)}
                    className="mt-2 flex min-h-11 items-center gap-1 rounded-full px-2 text-sm font-semibold text-gray-400 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                >
                    {expanded ? (
                        <>
                            <ChevronUp className="w-4 h-4" />
                            Свернуть
                        </>
                    ) : (
                        <>
                            <ChevronDown className="w-4 h-4" />
                            Показать ещё
                        </>
                    )}
                </button>
            )}
        </section>
    );
};
