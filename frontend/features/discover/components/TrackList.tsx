import { useCallback } from "react";
import Link from "next/link";
import { cn } from "@/utils/cn";
import { DiscoverTrack } from "../types";
import { api } from "@/lib/api";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import {
    TrackList as SharedTrackList,
    TrackListHeader,
} from "@/components/track";
import type {
    TrackRowItem,
    TrackRowSlots,
    OverflowConfig,
    RowState,
} from "@/components/track";
import type { ReactNode } from "react";
import { discoverRu } from "@/lib/i18n/discoverRu";

const tierColors: Record<string, string> = {
    high: "text-success",
    medium: "text-warning",
    explore: "text-brand",
    wildcard: "text-ai-hover",
    low: "text-brand",
    wild: "text-ai-hover",
};

const tierLabels: Record<string, string> = {
    high: discoverRu.tiers.high,
    medium: discoverRu.tiers.medium,
    explore: discoverRu.tiers.explore,
    wildcard: discoverRu.tiers.wildcard,
    low: discoverRu.tiers.explore,
    wild: discoverRu.tiers.wildcard,
};

interface TrackListProps {
    tracks: DiscoverTrack[];
    isMatching: boolean;
    currentTrack?: { id: string } | null;
    isPlaying: boolean;
    onPlayTrack: (index: number) => void;
    onTogglePlay: () => void;
}

function getSourceBadge(
    track: DiscoverTrack,
    isMatching: boolean,
    extraClassName?: string,
): ReactNode {
    if (track.sourceType === "tidal") {
        return <TidalBadge className={extraClassName} />;
    }

    if (track.sourceType === "youtube") {
        return <YouTubeBadge className={extraClassName} />;
    }

    let label: string;
    let badgeClassName: string;

    if (!track.available) {
        if (isMatching) {
            label = discoverRu.source.loading;
            badgeClassName =
                "animate-pulse border border-line-muted bg-surface-active text-content-muted motion-reduce:animate-none";
        } else {
            label = discoverRu.source.preview;
            badgeClassName = "border border-ai/30 bg-ai/10 text-ai-hover";
        }
    } else {
        label = discoverRu.source.local;
        badgeClassName = "border border-success/25 bg-success/10 text-success";
    }

    return (
        <span
            className={cn(
                "shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded",
                badgeClassName,
                extraClassName,
            )}
        >
            {label}
        </span>
    );
}

function toRowItem(track: DiscoverTrack): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        artistName: track.artist,
        duration: track.duration,
        coverArtUrl:
            track.coverUrl || track.albumId
                ? api.getCoverArtUrl(track.coverUrl || track.albumId, 80)
                : null,
    };
}

/**
 * Renders the TrackList component.
 */
export function TrackList({
    tracks,
    isMatching,
    currentTrack,
    isPlaying,
    onPlayTrack,
    onTogglePlay,
}: TrackListProps) {
    const handlePlay = useCallback(
        (_track: DiscoverTrack, index: number) => {
            const track = tracks[index];
            const isTrackPlaying = currentTrack?.id === track.id;
            if (isTrackPlaying && isPlaying) {
                onTogglePlay();
            } else {
                onPlayTrack(index);
            }
        },
        [tracks, currentTrack?.id, isPlaying, onPlayTrack, onTogglePlay],
    );

    const rowSlots = useCallback(
        (
            track: DiscoverTrack,
            _index: number,
            _state: RowState,
        ): TrackRowSlots => {
            const sourceBadge = getSourceBadge(track, isMatching);
            return {
                artistContent: (
                    <p className="truncate text-xs text-content-muted">
                        <Link
                            href={`/artist/${encodeURIComponent(track.artist)}`}
                            className="hover:text-content hover:underline"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {track.artist}
                        </Link>
                    </p>
                ),
                subtitleExtra: (
                    <div className="md:hidden mt-1">{sourceBadge}</div>
                ),
                middleColumns: (
                    <>
                        <p className="hidden items-center truncate text-sm text-content-muted md:flex">
                            {track.album}
                        </p>
                        <div className="hidden md:flex items-center justify-center">
                            <span
                                className={cn(
                                    "rounded-full border border-line bg-surface-elevated px-2 py-0.5 text-xs font-medium",
                                    tierColors[track.tier],
                                )}
                            >
                                {tierLabels[track.tier]?.split(" ")[0]}
                            </span>
                        </div>
                        <div className="hidden md:flex items-center justify-center">
                            {sourceBadge}
                        </div>
                    </>
                ),
            };
        },
        [isMatching],
    );

    const rowOverflow = useCallback(
        (track: DiscoverTrack): OverflowConfig => ({
            track: {
                id: track.id,
                title: track.title,
                artist: { name: track.artist, id: track.artistId ?? undefined },
                album: {
                    title: track.album,
                    id: track.albumId,
                    coverArt: track.coverUrl ?? track.albumId ?? undefined,
                },
                duration: track.duration,
                streamSource: track.streamSource,
            },
            showGoToAlbum: !!track.albumId,
        }),
        [],
    );

    return (
        <div className="w-full">
            <SharedTrackList
                items={tracks}
                toRowItem={toRowItem}
                onPlay={handlePlay}
                rowSlots={rowSlots}
                rowOverflow={rowOverflow}
                rowClassName="grid-cols-[28px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,2fr)_80px_90px_80px]"
                preferenceMode="up-only"
                header={
                    <TrackListHeader
                        className="grid-cols-[40px_minmax(200px,4fr)_minmax(100px,2fr)_80px_90px_80px] gap-4 mb-2"
                        columns={[
                            { label: "#", className: "text-center" },
                            { label: discoverRu.columns.title },
                            { label: discoverRu.columns.album },
                            {
                                label: discoverRu.columns.match,
                                className: "text-center",
                            },
                            {
                                label: discoverRu.columns.source,
                                className: "text-center",
                            },
                            { label: "" },
                        ]}
                    />
                }
            />
        </div>
    );
}
