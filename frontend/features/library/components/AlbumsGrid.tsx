import React, { memo, useCallback, useMemo } from "react";
import Link from "next/link";
import { Album } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { CachedImage } from "@/components/ui/CachedImage";
import { Disc3, Play, Trash2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { PeerBadge } from "@/components/ui/PeerBadge";

interface AlbumsGridProps {
    albums: Album[];
    onPlay: (albumId: string) => Promise<void>;
    onDelete: (albumId: string, albumTitle: string) => void;
    canDelete?: boolean;
    isLoading?: boolean;
    hidePlayButtons?: boolean;
}

interface AlbumCardItemProps {
    album: Album;
    index: number;
    onPlay: (albumId: string) => Promise<void>;
    onDelete: (albumId: string, albumTitle: string) => void;
    canDelete: boolean;
    hidePlayButtons: boolean;
}

const AlbumCardItem = memo(
    function AlbumCardItem({
        album,
        index,
        onPlay,
        onDelete,
        canDelete,
        hidePlayButtons,
    }: AlbumCardItemProps) {
        const { showSpinner: showPlaySpinner, trigger: triggerPlayFeedback } =
            usePlayButtonFeedback();

        const handlePlay = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                triggerPlayFeedback();
                onPlay(album.id);
            },
            [album.id, onPlay, triggerPlayFeedback],
        );
        const handleDelete = useCallback(
            (e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(album.id, album.title);
            },
            [album.id, album.title, onDelete],
        );

        const coverArtUrl = useMemo(
            () =>
                album.coverArt ? api.getCoverArtUrl(album.coverArt, 200) : null,
            [album.coverArt],
        );

        const albumHref = `/album/${album.id}`;
        const playLabel = `Воспроизвести альбом «${album.title}»`;
        const deleteLabel = `Удалить альбом «${album.title}»`;

        return (
            <article className="group min-w-0">
                <div className="relative mb-3 aspect-square">
                    <Link
                        href={albumHref}
                        prefetch={false}
                        data-tv-card
                        data-tv-card-index={index}
                        className="flex h-full w-full items-center justify-center overflow-hidden rounded-xl bg-surface-highlight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                        style={{ contain: "content" }}
                    >
                        {coverArtUrl ? (
                            <CachedImage
                                src={coverArtUrl}
                                alt={album.title}
                                fill
                                className="object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw"
                            />
                        ) : (
                            <Disc3 className="h-10 w-10 text-content-muted" />
                        )}
                    </Link>
                    {!hidePlayButtons &&
                        (album.source !== "federated" ||
                            album.peer?.online === true) && (
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
                    {canDelete && album.source !== "federated" && (
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
                    href={albumHref}
                    prefetch={false}
                    className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                >
                    <h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-content">
                        {album.title}
                    </h3>
                </Link>
                <div className="mt-0.5 flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-xs text-content-muted">
                        {album.artist?.name}
                    </p>
                    {album.source === "federated" && album.peer && (
                        <PeerBadge
                            peerName={album.peer.name}
                            online={album.peer.online}
                        />
                    )}
                </div>
            </article>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.album.id === nextProps.album.id;
    },
);

const AlbumsGrid = memo(function AlbumsGrid({
    albums,
    onPlay,
    onDelete,
    canDelete = false,
    isLoading = false,
    hidePlayButtons = false,
}: AlbumsGridProps) {
    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (albums.length === 0) {
        return (
            <EmptyState
                icon={<Disc3 className="w-12 h-12" />}
                title="Альбомов пока нет"
                description="В коллекции пока нет альбомов. Добавьте или сохраните музыку, чтобы начать."
            />
        );
    }

    return (
        <div
            data-tv-section="library-albums"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-4"
        >
            {albums.map((album, index) => (
                <AlbumCardItem
                    key={album.id}
                    album={album}
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

export { AlbumsGrid };
