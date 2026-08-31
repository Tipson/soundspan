import React, { memo, useCallback, useMemo } from "react";
import Link from "next/link";
import { Music, Play, Trash2, Loader2 } from "lucide-react";
import { Artist } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { CachedImage } from "@/components/ui/CachedImage";
import { api } from "@/lib/api";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { getArtistHref } from "@/utils/artistRoute";
import { PeerBadge } from "@/components/ui/PeerBadge";
import { pluralRu } from "@/lib/i18n/ru";

interface ArtistsGridProps {
    artists: Artist[];
    onPlay: (artistId: string) => Promise<void>;
    onDelete: (artistId: string, artistName: string) => void;
    canDelete?: boolean;
    isLoading?: boolean;
    hidePlayButtons?: boolean;
}

const getArtistImageSrc = (coverArt?: string | null): string | null => {
    if (!coverArt) return null;
    return api.getCoverArtUrl(coverArt, 200);
};

interface ArtistCardItemProps {
    artist: Artist;
    index: number;
    onPlay: (artistId: string) => Promise<void>;
    onDelete: (artistId: string, artistName: string) => void;
    canDelete: boolean;
    hidePlayButtons: boolean;
}

const ArtistCardItem = memo(
    function ArtistCardItem({
        artist,
        index,
        onPlay,
        onDelete,
        canDelete,
        hidePlayButtons,
    }: ArtistCardItemProps) {
        const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
            usePlayButtonFeedback();

        const handlePlay = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                triggerPlayFeedback();
                onPlay(artist.id);
            },
            [artist.id, onPlay, triggerPlayFeedback],
        );
        const handleDelete = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(artist.id, artist.name);
            },
            [artist.id, artist.name, onDelete],
        );

        const coverArtUrl = useMemo(
            () => getArtistImageSrc(artist.coverArt),
            [artist.coverArt],
        );
        const artistHref =
            getArtistHref({
                id: artist.id,
                mbid: artist.mbid,
                name: artist.name,
            }) || "/artist";

        const playLabel = `Воспроизвести исполнителя «${artist.name}»`;
        const deleteLabel = `Удалить исполнителя «${artist.name}»`;

        return (
            <article className="group min-w-0">
                <div className="relative mb-3 aspect-square">
                    <Link
                        href={artistHref}
                        prefetch={false}
                        data-tv-card
                        data-tv-card-index={index}
                        className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-surface-highlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        style={{ contain: "content" }}
                    >
                        {coverArtUrl ? (
                            <CachedImage
                                src={coverArtUrl}
                                alt={artist.name}
                                fill
                                className="object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw"
                            />
                        ) : (
                            <Music className="h-10 w-10 text-content-muted" />
                        )}
                    </Link>
                    {!hidePlayButtons &&
                        (artist.source !== "federated" ||
                            artist.peer?.online === true) && (
                            <button
                                type="button"
                                onClick={handlePlay}
                                aria-label={playLabel}
                                title={playLabel}
                                className="absolute bottom-2 right-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-brand-hover text-black shadow-xl transition-[opacity,transform] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                            >
                                {showPlaySpinner ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Play className="ml-0.5 h-4 w-4 fill-current" />
                                )}
                            </button>
                        )}
                    {canDelete && artist.source !== "federated" && (
                        <button
                            type="button"
                            onClick={handleDelete}
                            aria-label={deleteLabel}
                            title={deleteLabel}
                            className="absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-black/65 text-white shadow-lg transition-[opacity,background-color] hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 motion-reduce:transition-none sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                    )}
                </div>
                <Link
                    href={artistHref}
                    prefetch={false}
                    className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                >
                    <h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-content">
                        {artist.name}
                    </h3>
                </Link>
                <div className="mt-0.5 flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-xs text-content-muted">
                        {artist.albumCount || 0}{" "}
                        {pluralRu(artist.albumCount || 0, [
                            "альбом",
                            "альбома",
                            "альбомов",
                        ])}
                    </p>
                    {artist.source === "federated" && artist.peer && (
                        <PeerBadge
                            peerName={artist.peer.name}
                            online={artist.peer.online}
                        />
                    )}
                </div>
            </article>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.artist.id === nextProps.artist.id;
    },
);

const ArtistsGrid = memo(function ArtistsGrid({
    artists,
    onPlay,
    onDelete,
    canDelete = false,
    isLoading = false,
    hidePlayButtons = false,
}: ArtistsGridProps) {
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (artists.length === 0) {
        return (
            <EmptyState
                icon={<Music className="w-12 h-12" />}
                title="Исполнителей пока нет"
                description="В коллекции пока нет исполнителей. Добавьте или сохраните музыку, чтобы начать."
            />
        );
    }

    return (
        <div
            data-tv-section="library-artists"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4"
        >
            {artists.map((artist, index) => (
                <ArtistCardItem
                    key={artist.id}
                    artist={artist}
                    index={index}
                    onPlay={onPlay}
                    onDelete={onDelete}
                    canDelete={canDelete}
                    hidePlayButtons={hidePlayButtons}
                />
            ))}
        </div>
    );
});

export { ArtistsGrid };
