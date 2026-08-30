import Image from "next/image";
import Link from "next/link";
import { Disc3 } from "lucide-react";
import { api } from "@/lib/api";
import type { DiscoverResult } from "../types";

interface ProviderAlbumsGridProps {
    albums: DiscoverResult[];
    limit?: number | null;
    embedded?: boolean;
    indexOffset?: number;
}

/** Render browsable YouTube Music albums returned by global search. */
export function ProviderAlbumsGrid({
    albums,
    limit = 6,
    embedded = false,
    indexOffset = 0,
}: ProviderAlbumsGridProps) {
    const visibleAlbums =
        typeof limit === "number" ? albums.slice(0, limit) : albums;

    return (
        <div
            className={
                embedded
                    ? "contents"
                    : "grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10"
            }
            data-tv-section={embedded ? undefined : "search-results-albums"}
        >
            {visibleAlbums.map((album, index) => {
                const browseId = album.browseId || album.id;
                if (!browseId) return null;
                const imageUrl = album.image
                    ? api.getBrowseImageUrl(album.image)
                    : null;
                return (
                    <Link
                        key={browseId}
                        href={`/explore/yt-playlist/${encodeURIComponent(browseId)}?type=album`}
                        data-tv-card
                        data-tv-card-index={indexOffset + index}
                        tabIndex={0}
                        className="rounded-lg bg-surface-sunken p-4 transition-colors hover:bg-surface-elevated"
                    >
                        <div className="relative mb-4 flex aspect-square items-center justify-center overflow-hidden rounded-md bg-surface-elevated">
                            {imageUrl ? (
                                <Image
                                    src={imageUrl}
                                    alt={album.name}
                                    fill
                                    sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                                    className="object-cover"
                                    loading="lazy"
                                    unoptimized
                                />
                            ) : (
                                <Disc3 className="h-12 w-12 text-gray-400" />
                            )}
                        </div>
                        <h3 className="mb-1 line-clamp-1 text-base font-bold text-white">
                            {album.name}
                        </h3>
                        <p className="line-clamp-1 text-sm text-gray-400">
                            {[album.artist, album.year]
                                .filter(Boolean)
                                .join(" · ")}
                        </p>
                    </Link>
                );
            })}
        </div>
    );
}
