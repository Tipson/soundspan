"use client";

import Link from "next/link";
import { useState } from "react";
import { Disc3, Loader2, Play } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { api } from "@/lib/api";
import { pluralRu } from "@/lib/i18n/ru";
import type { Album } from "../types";

interface StreamingAlbumsProps {
    albums: Album[];
    onPlayAlbum: (albumId: string, albumTitle: string) => Promise<void>;
}

/** Display the listener's saved remote releases without claiming file ownership. */
export function StreamingAlbums({ albums, onPlayAlbum }: StreamingAlbumsProps) {
    const [pendingAlbum, setPendingAlbum] = useState<string | null>(null);
    async function playAlbum(album: Album) {
        setPendingAlbum(album.id);
        try {
            await onPlayAlbum(album.id, album.title);
        } finally {
            setPendingAlbum((current) =>
                current === album.id ? null : current,
            );
        }
    }
    if (albums.length === 0) return null;

    return (
        <section aria-label="Альбомы из любимых">
            <h2 className="text-2xl font-black tracking-[-0.03em] sm:text-3xl">
                Альбомы из любимых
            </h2>
            <p className="mb-5 mt-2 text-sm text-gray-400">
                Любимые треки из этих альбомов · онлайн
            </p>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {albums.map((album) => (
                    <article key={album.id} className="min-w-0">
                        <div className="relative">
                            <Link
                                href={`/album/${encodeURIComponent(album.id)}`}
                                title={album.title}
                                className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                            >
                                <div className="relative mb-3 flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-surface-highlight">
                                    {album.coverArt ? (
                                        <CachedImage
                                            src={api.getCoverArtUrl(
                                                album.coverArt,
                                                300,
                                            )}
                                            alt=""
                                            fill
                                            className="object-cover"
                                            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                                        />
                                    ) : (
                                        <Disc3
                                            className="h-12 w-12 text-gray-400"
                                            aria-hidden="true"
                                        />
                                    )}
                                </div>
                                <span className="line-clamp-2 min-h-12 font-semibold leading-6 text-white group-hover:underline">
                                    {album.title}
                                </span>
                            </Link>
                            <button
                                type="button"
                                aria-label={`Слушать любимые треки альбома ${album.title}`}
                                aria-busy={pendingAlbum === album.id}
                                disabled={pendingAlbum === album.id}
                                onClick={() => void playAlbum(album)}
                                className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full bg-surface text-white transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-wait"
                            >
                                {pendingAlbum === album.id ? (
                                    <Loader2
                                        className="h-5 w-5 animate-spin motion-reduce:animate-none"
                                        aria-hidden="true"
                                    />
                                ) : (
                                    <Play
                                        className="h-5 w-5 fill-current"
                                        aria-hidden="true"
                                    />
                                )}
                            </button>
                        </div>
                        <p className="mt-1 text-sm text-gray-400">
                            {[
                                album.year,
                                album.trackCount
                                    ? `${album.trackCount} ${pluralRu(album.trackCount, ["трек", "трека", "треков"])}`
                                    : null,
                            ]
                                .filter(Boolean)
                                .join(" · ")}
                        </p>
                    </article>
                ))}
            </div>
        </section>
    );
}
