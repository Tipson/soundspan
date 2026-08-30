import Link from "next/link";
import Image from "next/image";
import { ArrowUpRight, Music } from "lucide-react";
import { api } from "@/lib/api";
import { Artist, DiscoverResult } from "../types";
import { getArtistHref, getDiscoveryArtistHref } from "@/utils/artistRoute";
import { PeerBadge } from "@/components/ui/PeerBadge";
import { ru } from "@/lib/i18n/ru";
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

    // Keep provider-only identities out of the generic artist ID route.
    const artistHref = isLibrary
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

    return (
        <section
            data-tv-section="search-top-result"
            aria-labelledby="search-top-result-title"
            className="min-w-0"
        >
            <h2
                id="search-top-result-title"
                className="mb-4 text-xl font-black tracking-[-0.025em] text-content sm:text-2xl"
            >
                {ru.search.topResult}
            </h2>
            <Link
                href={artistHref}
                className="group relative isolate flex min-h-[13.5rem] w-full items-end overflow-hidden rounded-[1.5rem] border border-white/[0.09] bg-white/[0.035] p-5 shadow-xl shadow-black/20 transition duration-200 hover:-translate-y-0.5 hover:border-white/[0.16] hover:bg-white/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none sm:min-h-[15rem] sm:p-6"
                data-tv-card
                data-tv-card-index={0}
                tabIndex={0}
            >
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brand/25 via-brand/[0.04] to-transparent"
                />
                <div className="relative z-10 h-24 w-24 shrink-0 overflow-hidden rounded-full border border-white/10 bg-surface-elevated shadow-2xl shadow-black/40 sm:h-28 sm:w-28">
                    {imageUrl ? (
                        <Image
                            src={api.getCoverArtUrl(imageUrl, 200)}
                            alt={name}
                            fill
                            sizes="(min-width: 640px) 112px, 96px"
                            className="object-cover"
                            loading="eager"
                            fetchPriority="high"
                            unoptimized
                        />
                    ) : (
                        <span className="grid h-full w-full place-items-center">
                            <Music
                                className="h-11 w-11 text-content-muted"
                                aria-hidden="true"
                            />
                        </span>
                    )}
                </div>
                <div className="relative z-10 min-w-0 flex-1 px-4 sm:px-6">
                    <p className="mb-1 text-[0.6875rem] font-bold uppercase tracking-[0.18em] text-content-muted">
                        {ru.catalog.artist}
                    </p>
                    <h3 className="truncate text-3xl font-black tracking-[-0.045em] text-content sm:text-4xl">
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
                <span className="relative z-10 grid h-11 w-11 shrink-0 place-items-center rounded-full bg-content text-surface shadow-lg transition-transform duration-200 group-hover:scale-[1.04] motion-reduce:transition-none">
                    <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
                    <span className="sr-only">{ru.search.viewArtist}</span>
                </span>
            </Link>
        </section>
    );
}
