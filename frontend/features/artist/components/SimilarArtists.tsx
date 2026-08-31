"use client";

import Image from "next/image";
import { SimilarArtist } from "../types";
import { Music, Library } from "lucide-react";
import { api } from "@/lib/api";
import { getArtistRouteParam } from "@/utils/artistRoute";
import { pluralRu, ru } from "@/lib/i18n/ru";

interface SimilarArtistsProps {
    similarArtists: SimilarArtist[];
    onNavigate: (artistId: string) => void;
}

/**
 * Renders the SimilarArtists component.
 */
export function SimilarArtists({
    similarArtists,
    onNavigate,
}: SimilarArtistsProps) {
    if (!similarArtists || similarArtists.length === 0) {
        return null;
    }

    return (
        <section>
            <h2 className="mb-5 text-2xl font-black tracking-[-0.03em] sm:text-3xl">
                {ru.catalog.similarArtists}
            </h2>
            <div
                data-tv-section="similar-artists"
                className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
            >
                {similarArtists.map((artist, index) => {
                    const rawImage = artist.coverArt || artist.image;
                    const imageUrl = rawImage
                        ? api.getCoverArtUrl(rawImage, 300)
                        : null;
                    const matchPercentage = artist.weight
                        ? Math.round(artist.weight * 100)
                        : null;

                    // For library artists, use the library ID; otherwise use mbid or name
                    const navigationId =
                        getArtistRouteParam(
                            {
                                id: artist.id,
                                mbid: artist.mbid,
                                name: artist.name,
                            },
                            { preferLibraryId: artist.inLibrary },
                        ) || artist.id;

                    return (
                        <button
                            type="button"
                            key={artist.id || artist.name}
                            data-tv-card
                            data-tv-card-index={index}
                            onClick={() => onNavigate(navigationId)}
                            aria-label={`Открыть исполнителя ${artist.name}`}
                            className="group min-h-11 min-w-0 rounded-xl p-1.5 text-left transition duration-200 hover:-translate-y-0.5 hover:bg-white/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none sm:p-2"
                        >
                            {/* Circular Artist Image */}
                            <div className="w-full aspect-square bg-surface-highlight rounded-full mb-2.5 overflow-hidden relative shadow-lg">
                                {imageUrl ? (
                                    <Image
                                        src={imageUrl}
                                        alt={artist.name}
                                        fill
                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
                                        className="object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none"
                                        unoptimized
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Music className="w-12 h-12 text-gray-400" />
                                    </div>
                                )}
                                {/* Library indicator badge */}
                                {artist.inLibrary && (
                                    <div
                                        className="absolute bottom-1 right-1 bg-brand rounded-full p-1"
                                        title={ru.catalog.inLibrary}
                                    >
                                        <Library className="w-3 h-3 text-black" />
                                    </div>
                                )}
                            </div>

                            {/* Artist Name */}
                            <h3 className="text-sm font-semibold text-white truncate mb-0.5">
                                {artist.name}
                            </h3>

                            {/* Album Count - show owned count if in library */}
                            <p className="text-xs text-gray-400 truncate">
                                {artist.ownedAlbumCount &&
                                artist.ownedAlbumCount > 0
                                    ? `${artist.ownedAlbumCount} ${pluralRu(artist.ownedAlbumCount, ["альбом", "альбома", "альбомов"])} ${ru.catalog.albumsInLibrary}`
                                    : ru.catalog.artist}
                            </p>

                            {/* Match Percentage */}
                            {matchPercentage !== null && (
                                <p className="text-xs text-brand mt-1">
                                    {matchPercentage}% {ru.catalog.match}
                                </p>
                            )}
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
