"use client";

import { useCallback } from "react";
import { Play, Pause } from "lucide-react";
import Link from "next/link";
import { useAudioState } from "@/lib/audio-state-context";
import { usePlaybackStatus } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import { formatTime } from "@/utils/formatTime";
import { getArtistHref } from "@/utils/artistRoute";
import { TrackList } from "@/components/track";
import type { TrackRowItem, TrackRowSlots, RowState } from "@/components/track";
import type { LibraryTrack } from "../types";
import { PeerBadge } from "@/components/ui/PeerBadge";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";

interface LibraryTracksListProps {
    tracks: LibraryTrack[];
    limit?: number | null;
}

function toRowItem(track: LibraryTrack): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        artistName: track.album.artist.name,
        duration: track.duration,
        coverArtUrl: track.album.coverUrl
            ? api.getCoverArtUrl(track.album.coverUrl, 48)
            : null,
        isPlayable: track.source !== "federated" || track.peer?.online === true,
        unplayableReason:
            track.source === "federated" && track.peer?.online === false
                ? "peer_offline"
                : undefined,
    };
}

function isTrackPlayable(track: LibraryTrack): boolean {
    return track.source !== "federated" || track.peer?.online === true;
}

function toPlaybackTrack(track: LibraryTrack) {
    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        duration: track.duration,
        artist: {
            id: track.album.artist.id,
            name: track.album.artist.name,
        },
        album: {
            id: track.album.id,
            title: track.album.title,
            coverArt: track.album.coverUrl,
            albumLoudnessLufs: track.album.albumLoudnessLufs ?? null,
            albumTruePeakDb: track.album.albumTruePeakDb ?? null,
        },
        loudnessLufs: track.loudnessLufs ?? null,
        truePeakDb: track.truePeakDb ?? null,
        source: track.source,
        peer: track.peer,
    };
}

/**
 * Renders the LibraryTracksList component.
 */
export function LibraryTracksList({
    tracks,
    limit = 10,
}: LibraryTracksListProps) {
    const { currentTrack } = useAudioState();
    const { isPlaying } = usePlaybackStatus();
    const { playTracks, pause, resume } = useAudioControls();
    const allTracks = tracks ?? [];
    const visibleTracks =
        typeof limit === "number" ? allTracks.slice(0, limit) : allTracks;
    const playableVisibleTracks = visibleTracks.filter(isTrackPlayable);

    const handlePlay = useCallback(
        (track: LibraryTrack) => {
            const playableIndex = playableVisibleTracks.findIndex(
                (candidate) => candidate.id === track.id,
            );
            if (playableIndex < 0) return;

            if (currentTrack?.id === track.id) {
                if (isPlaying) {
                    pause();
                } else {
                    resume();
                }
            } else {
                playTracks(
                    playableVisibleTracks.map(toPlaybackTrack),
                    playableIndex,
                );
            }
        },
        [
            currentTrack?.id,
            isPlaying,
            pause,
            playTracks,
            playableVisibleTracks,
            resume,
        ],
    );

    const rowSlots = useCallback(
        (
            track: LibraryTrack,
            index: number,
            _state: RowState,
        ): TrackRowSlots => {
            const isCurrentTrack = currentTrack?.id === track.id;
            const isPlayingThis = isCurrentTrack && isPlaying;
            const artistHref =
                getArtistHref({
                    id: track.album.artist.id,
                    mbid: track.album.artist.mbid,
                    name: track.album.artist.name,
                }) || "/artist";

            return {
                titleBadges:
                    track.source === "federated" && track.peer ? (
                        <PeerBadge
                            peerName={track.peer.name}
                            online={track.peer.online}
                        />
                    ) : undefined,
                leadingColumn: (
                    <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
                        {isPlayingThis ? (
                            <Pause className="w-4 h-4 text-brand" />
                        ) : isCurrentTrack ? (
                            <Play className="w-4 h-4 text-brand ml-0.5" />
                        ) : (
                            <>
                                <span className="text-sm text-gray-400 group-hover:hidden">
                                    {index + 1}
                                </span>
                                <Play className="w-4 h-4 text-white hidden group-hover:block ml-0.5" />
                            </>
                        )}
                    </div>
                ),
                artistContent: (
                    <p className="text-xs text-gray-400 truncate">
                        <Link
                            href={artistHref}
                            className="hover:underline hover:text-white"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {track.album.artist.name}
                        </Link>
                        <span className="mx-1">&bull;</span>
                        <Link
                            href={`/album/${track.album.id}`}
                            className="hover:underline hover:text-white"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {track.album.title}
                        </Link>
                    </p>
                ),
                trailingActions: (
                    <div
                        className="flex items-center justify-end gap-1 flex-shrink-0"
                        role="presentation"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                    >
                        <span className="text-sm text-gray-400">
                            {formatTime(track.duration)}
                        </span>
                        <TrackPreferenceButtons
                            trackId={track.id}
                            mode="both"
                            buttonSizeClassName="h-11 w-11"
                            iconSizeClassName="h-4 w-4"
                            metadata={buildPreferenceMetadata({
                                id: track.id,
                                title: track.title,
                                duration: track.duration,
                                artist: { name: track.album.artist.name },
                                album: { title: track.album.title },
                            })}
                        />
                        <TrackOverflowMenu
                            triggerClassName="h-11 w-11 p-0"
                            track={{
                                id: track.id,
                                title: track.displayTitle ?? track.title,
                                artist: {
                                    id: track.album.artist.id,
                                    name: track.album.artist.name,
                                    mbid: track.album.artist.mbid,
                                },
                                album: {
                                    id: track.album.id,
                                    title: track.album.title,
                                    coverArt: track.album.coverUrl,
                                },
                                duration: track.duration,
                                source: track.source,
                                peer: track.peer,
                            }}
                        />
                    </div>
                ),
            };
        },
        [currentTrack?.id, isPlaying],
    );

    if (allTracks.length === 0) {
        return null;
    }

    return (
        <TrackList
            items={visibleTracks}
            toRowItem={toRowItem}
            onPlay={handlePlay}
            rowSlots={rowSlots}
            rowClassName="grid-cols-[auto_1fr_auto]"
            className="space-y-1"
            preferenceMode={null}
        />
    );
}
