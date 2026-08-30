import Image from "next/image";
import Link from "next/link";
import { Music } from "lucide-react";
import { PeerBadge } from "@/components/ui/PeerBadge";
import { api } from "@/lib/api";
import { formatListeners } from "@/lib/format";
import { getArtistHref, getDiscoveryArtistHref } from "@/utils/artistRoute";
import {
    hasCanonicalProviderArtistIdentity,
    normalizeArtistName,
} from "../discoverySelection";
import type { Artist, DiscoverResult } from "../types";

interface SearchArtistsGridProps {
    libraryArtists: Artist[];
    discoveryArtists: DiscoverResult[];
    excludeNames?: string[];
    limit?: number | null;
}

type SearchArtistCard =
    | { kind: "library"; artist: Artist }
    | { kind: "discovery"; artist: DiscoverResult };

function mergeSearchArtists(
    libraryArtists: Artist[],
    discoveryArtists: DiscoverResult[],
    excludeNames: string[],
): SearchArtistCard[] {
    const excluded = new Set(excludeNames.map(normalizeArtistName));
    const cardIndexByName = new Map<string, number>();
    const cards: SearchArtistCard[] = [];

    for (const artist of libraryArtists) {
        const key = normalizeArtistName(artist.name);
        if (!key || excluded.has(key) || cardIndexByName.has(key)) continue;
        cardIndexByName.set(key, cards.length);
        cards.push({ kind: "library", artist });
    }

    for (const artist of discoveryArtists) {
        if (artist.type !== "music") continue;
        const key = normalizeArtistName(artist.name);
        if (!key || excluded.has(key)) continue;
        const duplicateIndex = cardIndexByName.get(key);
        if (duplicateIndex !== undefined) {
            if (hasCanonicalProviderArtistIdentity(artist)) {
                cards[duplicateIndex] = { kind: "discovery", artist };
            }
            continue;
        }
        cardIndexByName.set(key, cards.length);
        cards.push({ kind: "discovery", artist });
    }

    return cards;
}

/** Render deduplicated local, peer, and provider artist search matches. */
export function SearchArtistsGrid({
    libraryArtists,
    discoveryArtists,
    excludeNames = [],
    limit = 6,
}: SearchArtistsGridProps) {
    const mergedArtists = mergeSearchArtists(
        libraryArtists,
        discoveryArtists,
        excludeNames,
    );
    const visibleArtists =
        typeof limit === "number"
            ? mergedArtists.slice(0, limit)
            : mergedArtists;

    if (visibleArtists.length === 0) return null;

    return (
        <div
            className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10"
            data-tv-section="search-results-artists"
        >
            {visibleArtists.map((card, index) => {
                const artistName = card.artist.name;
                let href: string | null;
                let image: string | undefined;
                let subtitle: string;
                let peer: Artist["peer"] | undefined;
                if (card.kind === "library") {
                    const artist = card.artist;
                    href = getArtistHref({
                        id: artist.id,
                        mbid: artist.mbid,
                        name: artist.name,
                    });
                    image = artist.heroUrl;
                    subtitle = "Artist";
                    peer =
                        artist.source === "federated" ? artist.peer : undefined;
                } else {
                    const artist = card.artist;
                    href = getDiscoveryArtistHref({
                        id: artist.id,
                        mbid: artist.mbid,
                        name: artist.name,
                        youtubeChannelId: artist.youtubeChannelId,
                    });
                    image = artist.image;
                    subtitle = formatListeners(artist.listeners);
                    peer = undefined;
                }
                const imageUrl = image ? api.getCoverArtUrl(image, 200) : null;

                return (
                    <Link
                        key={`${card.kind}-${href ?? artistName}`}
                        href={
                            href || `/artist/${encodeURIComponent(artistName)}`
                        }
                        data-tv-card
                        data-tv-card-index={index}
                        tabIndex={0}
                        className="group rounded-lg bg-surface-sunken p-4 transition-colors hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                        <div className="relative mb-4 flex aspect-square items-center justify-center overflow-hidden rounded-full bg-surface-elevated">
                            {imageUrl ? (
                                <Image
                                    src={imageUrl}
                                    alt={artistName}
                                    fill
                                    sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                                    className="object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none"
                                    loading="lazy"
                                    unoptimized
                                />
                            ) : (
                                <Music className="h-12 w-12 text-gray-400" />
                            )}
                        </div>
                        <h3 className="mb-1 line-clamp-1 text-base font-bold text-white">
                            {artistName}
                        </h3>
                        <div className="flex items-center gap-2">
                            <p className="min-w-0 flex-1 truncate text-sm text-content-secondary">
                                {subtitle}
                            </p>
                            {peer ? (
                                <PeerBadge
                                    peerName={peer.name}
                                    online={peer.online}
                                />
                            ) : null}
                        </div>
                    </Link>
                );
            })}
        </div>
    );
}
