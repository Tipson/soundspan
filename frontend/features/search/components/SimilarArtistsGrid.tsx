import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { DiscoverResult } from "../types";
import { api } from "@/lib/api";
import { formatListeners } from "@/lib/format";
import { getDiscoveryArtistHref } from "@/utils/artistRoute";

interface SimilarArtistsGridProps {
    similarArtists: DiscoverResult[];
    title?: string;
    titleHref?: string;
}

const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 200);
};

/**
 * Renders the SimilarArtistsGrid component.
 */
export function SimilarArtistsGrid({
    similarArtists,
    title = "Related Artists",
    titleHref,
}: SimilarArtistsGridProps) {
    if (similarArtists.length === 0) {
        return null;
    }

    return (
        <section>
            {titleHref ? (
                <h2 className="mb-5 text-xl font-black tracking-[-0.025em] text-content sm:text-2xl">
                    <Link
                        href={titleHref}
                        className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light"
                    >
                        {title}
                    </Link>
                </h2>
            ) : (
                <h2 className="mb-5 text-xl font-black tracking-[-0.025em] text-content sm:text-2xl">
                    {title}
                </h2>
            )}
            <div
                className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-6"
                data-tv-section="search-results-artists"
            >
                {similarArtists.map((result, index) => {
                    const artistHref =
                        getDiscoveryArtistHref({
                            id: result.id,
                            mbid: result.mbid,
                            name: result.name,
                            youtubeChannelId: result.youtubeChannelId,
                        }) || `/artist/${encodeURIComponent(result.name)}`;
                    const imageUrl = getProxiedImageUrl(result.image);

                    return (
                        <Link
                            key={`artist-${artistHref}-${index}`}
                            href={artistHref}
                            data-tv-card
                            data-tv-card-index={index}
                            tabIndex={0}
                            className="group min-w-0 rounded-2xl border border-transparent bg-white/[0.025] p-3 transition duration-200 hover:-translate-y-0.5 hover:border-white/[0.1] hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none sm:p-4"
                        >
                            <div className="relative mb-3 flex aspect-square items-center justify-center overflow-hidden rounded-full bg-surface-elevated shadow-lg shadow-black/15 sm:mb-4">
                                {imageUrl ? (
                                    <Image
                                        src={imageUrl}
                                        alt={result.name}
                                        fill
                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                                        className="object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                                        loading="lazy"
                                        unoptimized
                                    />
                                ) : (
                                    <Music className="h-10 w-10 text-content-muted sm:h-12 sm:w-12" />
                                )}
                            </div>
                            <h3 className="mb-1 line-clamp-1 text-sm font-bold text-content sm:text-base">
                                {result.name}
                            </h3>
                            <p className="text-xs text-content-secondary sm:text-sm">
                                {formatListeners(result.listeners)}
                            </p>
                        </Link>
                    );
                })}
            </div>
        </section>
    );
}
