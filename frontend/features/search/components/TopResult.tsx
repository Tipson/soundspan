import Link from "next/link";
import { ArrowUpRight, Music } from "lucide-react";
import { api } from "@/lib/api";
import { Artist, DiscoverResult } from "../types";
import { getArtistHref, getDiscoveryArtistHref } from "@/utils/artistRoute";
import { PeerBadge } from "@/components/ui/PeerBadge";
import { ru } from "@/lib/i18n/ru";
import { normalizeArtistName } from "../discoverySelection";
import { CachedImage } from "@/components/ui/CachedImage";
interface TopResultProps {
    libraryArtist?: Artist;
    discoveryArtist?: DiscoverResult;
    preferDiscovery?: boolean;
}

/**
 * Renders the TopResult component.
 */
export function TopResult({
    libraryArtist,
    discoveryArtist,
    preferDiscovery = false,
}: TopResultProps) {
    // Prefer library artist over discovery unless the discovery result is
    // an exact match for the query and the library artist is only fuzzy.
    if (!libraryArtist && !discoveryArtist) {
        return null;
    }

    const isLibrary =
        !!libraryArtist && !(preferDiscovery && !!discoveryArtist);

    // Get the display name
    const name = isLibrary
        ? libraryArtist?.name || ""
        : discoveryArtist?.name || "";

    const matchingProviderArtist =
        isLibrary &&
        discoveryArtist?.youtubeChannelId &&
        normalizeArtistName(discoveryArtist.name) ===
            normalizeArtistName(libraryArtist?.name ?? "")
            ? discoveryArtist
            : null;
    // When search merged an exact library row with a provider result, keep
    // the library artwork but open the provider-aware page. The generic local
    // route can only enumerate files/federated rows, not the online catalog.
    const artistHref = matchingProviderArtist
        ? getDiscoveryArtistHref({
              id: matchingProviderArtist.id,
              mbid: matchingProviderArtist.mbid,
              name: matchingProviderArtist.name,
              youtubeChannelId: matchingProviderArtist.youtubeChannelId,
          }) || `/artist/${encodeURIComponent(name)}`
        : isLibrary
          ? getArtistHref({
                id: libraryArtist?.id,
                mbid: libraryArtist?.mbid,
                name: libraryArtist?.name,
            }) || `/artist/${encodeURIComponent(name)}`
          : getDiscoveryArtistHref({
                id: discoveryArtist?.id,
                mbid: discoveryArtist?.mbid,
                name: discoveryArtist?.name,
                youtubeChannelId: discoveryArtist?.youtubeChannelId,
            }) || `/artist/${encodeURIComponent(name)}`;

    // Get the image URL
    const imageUrl = isLibrary
        ? libraryArtist?.heroUrl
        : discoveryArtist?.image;
    const alternativeImage =
        isLibrary &&
        discoveryArtist &&
        normalizeArtistName(discoveryArtist.name) === normalizeArtistName(name)
            ? discoveryArtist.image
            : undefined;
    const artworkPlaceholder = (
        <span className="grid h-full w-full place-items-center">
            <Music
                className="h-11 w-11 text-content-muted"
                aria-hidden="true"
            />
        </span>
    );
    const artworkFallback =
        alternativeImage && alternativeImage !== imageUrl ? (
            <CachedImage
                src={api.getCoverArtUrl(alternativeImage, 200)}
                alt={name}
                fill
                sizes="(min-width: 640px) 112px, 96px"
                className="object-cover"
                loading="eager"
                fallback={artworkPlaceholder}
            />
        ) : (
            artworkPlaceholder
        );

    return (
        <section
            data-tv-section="search-top-result"
            data-search-artist-feature="editorial"
            aria-labelledby="search-top-result-title"
            className="min-w-0"
        >
            <h2
                id="search-top-result-title"
                className="mb-3 text-xl font-semibold tracking-[-0.02em] text-content sm:text-2xl"
            >
                {ru.search.topResult}
            </h2>
            <Link
                href={artistHref}
                className="group relative isolate flex min-h-40 w-full flex-wrap items-center gap-3 overflow-hidden rounded-[14px] bg-surface-raised p-4 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none sm:min-h-48 sm:p-5"
                data-tv-card
                data-tv-card-index={0}
                tabIndex={0}
            >
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 bg-gradient-to-r from-brand/[0.06] to-transparent"
                />
                <div className="relative z-10 h-20 w-20 shrink-0 overflow-hidden rounded-full bg-surface-elevated sm:h-28 sm:w-28">
                    {imageUrl ? (
                        <CachedImage
                            src={api.getCoverArtUrl(imageUrl, 200)}
                            alt={name}
                            fill
                            sizes="(min-width: 640px) 112px, 96px"
                            className="object-cover"
                            loading="eager"
                            fetchPriority="high"
                            fallback={artworkFallback}
                        />
                    ) : (
                        artworkFallback
                    )}
                </div>
                <div className="relative z-10 order-3 w-full min-w-0 basis-full">
                    <p className="mb-1 text-xs font-medium text-content-secondary">
                        {ru.catalog.artist}
                    </p>
                    <h3 className="text-2xl font-bold leading-tight tracking-[-0.03em] text-content [overflow-wrap:break-word] sm:text-3xl">
                        {name}
                    </h3>
                    {isLibrary &&
                        libraryArtist?.source === "federated" &&
                        libraryArtist.peer && (
                            <PeerBadge
                                className="mt-2"
                                peerName={libraryArtist.peer.name}
                                online={libraryArtist.peer.online}
                            />
                        )}
                </div>
                <span className="relative z-10 ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-[10px] text-content-secondary transition-colors duration-200 group-hover:bg-surface-active group-hover:text-content motion-reduce:transition-none">
                    <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
                    <span className="sr-only">{ru.search.viewArtist}</span>
                </span>
            </Link>
        </section>
    );
}
