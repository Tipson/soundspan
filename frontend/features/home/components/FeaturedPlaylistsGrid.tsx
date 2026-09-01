"use client";

import { Music2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
    HorizontalCarousel,
    CarouselItem,
} from "@/components/ui/HorizontalCarousel";
import { memo, useCallback } from "react";
import type { PlaylistPreview } from "@/hooks/useQueries";
import { pluralRu } from "@/lib/i18n/ru";

export type { PlaylistPreview };

interface FeaturedPlaylistsGridProps {
    playlists: PlaylistPreview[];
}

interface PlaylistCardProps {
    playlist: PlaylistPreview;
    index: number;
    onClick: (playlistId: string) => void;
}

const PlaylistCard = memo(function PlaylistCard({
    playlist,
    index,
    onClick,
}: PlaylistCardProps) {
    const handleClick = () => {
        onClick(playlist.id);
    };

    return (
        <CarouselItem>
            <button
                type="button"
                onClick={handleClick}
                data-tv-card
                data-tv-card-index={index}
                aria-label={playlist.title}
                className="group w-full rounded-xl p-3 text-left transition-colors hover:bg-surface-hover"
            >
                <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-surface-highlight shadow-lg">
                    {playlist.imageUrl ? (
                        <img
                            src={playlist.imageUrl}
                            alt={playlist.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand/30 to-brand/10">
                            <Music2 className="w-10 h-10 text-gray-400" />
                        </div>
                    )}
                </div>
                <h3 className="text-sm font-semibold text-white truncate">
                    {playlist.title}
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">
                    {playlist.trackCount != null
                        ? `${playlist.trackCount} ${pluralRu(playlist.trackCount, ["трек", "трека", "треков"])}`
                        : (playlist.description ?? "")}
                </p>
            </button>
        </CarouselItem>
    );
});

/**
 * Renders a horizontal carousel of playlist preview cards.
 */
export const FeaturedPlaylistsGrid = memo(function FeaturedPlaylistsGrid({
    playlists,
}: FeaturedPlaylistsGridProps) {
    const router = useRouter();

    const handlePlaylistClick = useCallback(
        (playlistId: string) => {
            router.push(`/explore/yt-playlist/${playlistId}`);
        },
        [router],
    );

    if (!playlists || playlists.length === 0) {
        return null;
    }

    return (
        <HorizontalCarousel>
            {playlists.slice(0, 20).map((playlist, index) => (
                <PlaylistCard
                    key={`home-playlist-${playlist.id}-${index}`}
                    playlist={playlist}
                    index={index}
                    onClick={handlePlaylistClick}
                />
            ))}
        </HorizontalCarousel>
    );
});
