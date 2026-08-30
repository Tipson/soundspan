"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Music, Play } from "lucide-react";
import { DiscoverResult } from "../types";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { getArtistRouteParam } from "@/utils/artistRoute";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import {
    formatGoToSearchArtistAria,
    formatPlaySearchTrackAria,
} from "@/lib/i18n/searchExtrasRu";
import {
    useSearchTrackMatches,
    type SearchMatchTarget,
    type SearchProviderMatch,
} from "../hooks/useSearchTrackMatches";

interface DiscoverTracksListProps {
    tracks: DiscoverResult[];
    limit?: number | null;
}

const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 100);
};

const getTrackArtistHref = (track: DiscoverResult): string | null => {
    if (!track.artist) return null;
    const routeParam =
        getArtistRouteParam(
            { name: track.artist },
            { preferLibraryId: false },
        ) || encodeURIComponent(track.artist);
    return `/artist/${routeParam}`;
};

function rowKey(track: DiscoverResult, index: number): string {
    return `discover-track-${track.id || track.name}-${index}`;
}

function toPlaybackTrack(
    track: DiscoverResult,
    key: string,
    match: SearchProviderMatch,
) {
    const playbackId =
        match.source === "tidal" && match.tidalTrackId
            ? `tidal:${match.tidalTrackId}`
            : match.source === "youtube" && match.youtubeVideoId
              ? `yt:${match.youtubeVideoId}`
              : key;
    return {
        id: playbackId,
        title: track.name,
        artist: { name: track.artist ?? "" },
        album: { title: track.album ?? "" },
        duration: match.duration ?? track.duration ?? 0,
        streamSource: match.source,
        ...(match.source === "tidal"
            ? { tidalTrackId: match.tidalTrackId }
            : { youtubeVideoId: match.youtubeVideoId }),
    };
}

function getDirectProviderMatch(
    track: DiscoverResult,
): SearchProviderMatch | null {
    if (track.streamSource === "youtube" && track.youtubeVideoId) {
        return {
            source: "youtube",
            youtubeVideoId: track.youtubeVideoId,
            duration: track.duration ?? undefined,
        };
    }
    if (track.streamSource === "tidal" && track.tidalTrackId) {
        return {
            source: "tidal",
            tidalTrackId: track.tidalTrackId,
            duration: track.duration ?? undefined,
        };
    }
    return null;
}

/**
 * Renders external catalog track results. Rows with exact provider identities
 * play directly, metadata-only rows use provider matching, and unmatched rows
 * link to the artist page.
 */
export function DiscoverTracksList({
    tracks,
    limit = 10,
}: DiscoverTracksListProps) {
    const router = useRouter();
    const { playTracks } = useAudioControls();

    const visibleTracks = useMemo(
        () => (limit === null ? tracks : tracks.slice(0, limit)),
        [tracks, limit],
    );

    const directMatches = useMemo(() => {
        const direct = new Map<string, SearchProviderMatch>();
        visibleTracks.forEach((track, index) => {
            const match = getDirectProviderMatch(track);
            if (match) direct.set(rowKey(track, index), match);
        });
        return direct;
    }, [visibleTracks]);

    const matchTargets = useMemo(
        (): SearchMatchTarget[] =>
            visibleTracks.flatMap((track, index) => {
                if (!track.artist || getDirectProviderMatch(track)) return [];
                return [
                    {
                        key: rowKey(track, index),
                        artist: track.artist,
                        title: track.name,
                        album: track.album ?? undefined,
                    },
                ];
            }),
        [visibleTracks],
    );
    const { matches: resolvedMatches } = useSearchTrackMatches(matchTargets);
    const matches = useMemo(() => {
        const merged = new Map(resolvedMatches);
        directMatches.forEach((match, key) => merged.set(key, match));
        return merged;
    }, [directMatches, resolvedMatches]);

    const playableQueue = useMemo(
        () =>
            visibleTracks.flatMap((track, index) => {
                const key = rowKey(track, index);
                const match = matches.get(key);
                return match
                    ? [{ key, track: toPlaybackTrack(track, key, match) }]
                    : [];
            }),
        [matches, visibleTracks],
    );

    const handleRowClick = useCallback(
        (track: DiscoverResult, key: string) => {
            const match = matches.get(key);
            if (match) {
                const selectedIndex = playableQueue.findIndex(
                    (candidate) => candidate.key === key,
                );
                if (selectedIndex < 0) return;
                playTracks(
                    playableQueue.map((candidate) => candidate.track),
                    selectedIndex,
                );
                return;
            }
            const artistHref = getTrackArtistHref(track);
            if (artistHref) router.push(artistHref);
        },
        [matches, playableQueue, playTracks, router],
    );

    if (tracks.length === 0) {
        return null;
    }

    return (
        <div className="space-y-1.5" data-tv-section="search-discover-tracks">
            {visibleTracks.map((track, index) => {
                const imageUrl = getProxiedImageUrl(track.image);
                const key = rowKey(track, index);
                const match = matches.get(key);
                const isPlayable = Boolean(match);
                const actionTrack = match
                    ? toPlaybackTrack(track, key, match)
                    : {
                          id: key,
                          title: track.name,
                          artist: { name: track.artist ?? "" },
                          album: { title: track.album ?? "" },
                          duration: track.duration ?? 0,
                      };

                return (
                    <div
                        key={key}
                        role="button"
                        tabIndex={0}
                        data-tv-card
                        data-tv-card-index={index}
                        onClick={() => handleRowClick(track, key)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleRowClick(track, key);
                            }
                        }}
                        className="group flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 transition-colors hover:border-white/[0.06] hover:bg-white/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:gap-4 sm:px-3"
                        aria-label={
                            isPlayable
                                ? formatPlaySearchTrackAria(
                                      track.name,
                                      track.artist,
                                  )
                                : formatGoToSearchArtistAria(track.artist)
                        }
                    >
                        <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-elevated">
                            {imageUrl ? (
                                <Image
                                    src={imageUrl}
                                    alt={track.name}
                                    fill
                                    sizes="40px"
                                    className="object-cover"
                                    unoptimized
                                />
                            ) : (
                                <Music className="h-5 w-5 text-content-muted" />
                            )}
                            {isPlayable && (
                                <div className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/50">
                                    <Play className="w-4 h-4 text-white" />
                                </div>
                            )}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="flex truncate text-sm font-semibold text-content items-center gap-1.5">
                                <span className="truncate">{track.name}</span>
                                {match?.source === "tidal" && <TidalBadge />}
                                {match?.source === "youtube" && (
                                    <YouTubeBadge />
                                )}
                            </p>
                            <p className="truncate text-xs text-content-secondary">
                                {track.artist}
                                {track.album ? ` — ${track.album}` : ""}
                            </p>
                        </div>
                        <div
                            className="flex items-center"
                            role="presentation"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                        >
                            <TrackOverflowMenu
                                track={actionTrack}
                                showPlayNext={isPlayable}
                                showAddToQueue={isPlayable}
                                showAddToPlaylist={isPlayable}
                                showMatchVibe={false}
                                showVibeMap={false}
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
