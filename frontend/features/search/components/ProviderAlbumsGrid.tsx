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
                    : "grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6"
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
                        className="group min-w-0 rounded-xl p-1.5 transition duration-200 hover:-translate-y-0.5 hover:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none sm:p-2"
                    >
                        <div className="relative mb-3 flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-surface-elevated shadow-lg shadow-black/20">
                            {imageUrl ? (
                                <Image
                                    src={imageUrl}
                                    alt={album.name}
                                    fill
                                    sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                                    className="object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                                    loading="lazy"
                                    unoptimized
                                />
                            ) : (
                                <Disc3 className="h-10 w-10 text-content-muted sm:h-12 sm:w-12" />
                            )}
                        </div>
                        <h3 className="mb-1 line-clamp-1 text-sm font-bold text-content sm:text-base">
                            {album.name}
                        </h3>
                        <p className="line-clamp-1 text-xs text-content-secondary sm:text-sm">
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
