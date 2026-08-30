import Link from "next/link";
import { Disc3 } from "lucide-react";
import Image from "next/image";
import { api } from "@/lib/api";
import { Album } from "../types";
import { PeerBadge } from "@/components/ui/PeerBadge";

interface LibraryAlbumsGridProps {
    albums: Album[];
    limit?: number | null;
    embedded?: boolean;
    indexOffset?: number;
}

/**
 * Renders the LibraryAlbumsGrid component.
 */
export function LibraryAlbumsGrid({
    albums,
    limit = 6,
    embedded = false,
    indexOffset = 0,
}: LibraryAlbumsGridProps) {
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
                const coverArtId = album.coverUrl || album.albumId;
                return (
                    <Link
                        key={album.id}
                        href={`/album/${album.id}`}
                        data-tv-card
                        data-tv-card-index={indexOffset + index}
                        tabIndex={0}
                        className="group min-w-0 rounded-2xl border border-transparent bg-white/[0.025] p-3 transition duration-200 hover:-translate-y-0.5 hover:border-white/[0.1] hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none sm:p-4"
                    >
                        <div className="relative mb-3 flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-surface-elevated shadow-lg shadow-black/15 sm:mb-4">
                            {coverArtId ? (
                                <Image
                                    src={api.getCoverArtUrl(coverArtId, 200)}
                                    alt={album.title}
                                    fill
                                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 16vw"
                                    className="object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                                    loading="lazy"
                                    unoptimized
                                />
                            ) : (
                                <Disc3 className="h-10 w-10 text-content-muted sm:h-12 sm:w-12" />
                            )}
                        </div>
                        <h3 className="mb-1 line-clamp-1 text-sm font-bold text-content sm:text-base">
                            {album.title}
                        </h3>
                        <div className="flex items-center gap-2">
                            <p className="min-w-0 flex-1 truncate text-xs text-content-secondary sm:text-sm">
                                {album.artist?.name}
                            </p>
                            {album.source === "federated" && album.peer && (
                                <PeerBadge
                                    peerName={album.peer.name}
                                    online={album.peer.online}
                                />
                            )}
                        </div>
                    </Link>
                );
            })}
        </div>
    );
}
