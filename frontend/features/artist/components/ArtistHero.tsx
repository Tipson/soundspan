"use client";

import { Music } from "lucide-react";
import Image from "next/image";
import { Artist, ArtistSource, Album } from "../types";
import { ReactNode, lazy, Suspense } from "react";
import { useArtistDisplayData } from "@/hooks/useMetadataDisplay";
import type { ColorPalette } from "@/hooks/useImageColor";

// Lazy load MetadataEditor - modal component opened on user action
const MetadataEditor = lazy(() =>
    import("@/components/MetadataEditor").then((mod) => ({
        default: mod.MetadataEditor,
    })),
);

interface ArtistHeroProps {
    artist: Artist;
    source: ArtistSource;
    albums: Album[];
    heroImage: string | null;
    backgroundImage?: string | null;
    colors: ColorPalette | null;
    onReload: () => void;
    children?: ReactNode;
}

/**
 * Renders the ArtistHero component.
 */
export function ArtistHero({
    artist,
    source,
    albums,
    heroImage,
    backgroundImage,
    colors,
    onReload,
    children,
}: ArtistHeroProps) {
    const displayData = useArtistDisplayData(artist);
    const ownedAlbums = albums.filter((a) => a.owned);

    // Use background image if provided, otherwise fall back to hero image
    const bgImage = backgroundImage || heroImage;

    return (
        <div className="relative">
            {/* Background Image with VibrantJS gradient */}
            {bgImage ? (
                <div className="absolute inset-0 overflow-hidden">
                    <div className="absolute inset-0 scale-110 blur-md opacity-50">
                        <Image
                            src={bgImage}
                            alt={displayData.name}
                            fill
                            sizes="100vw"
                            className="object-cover"
                            priority
                            unoptimized
                        />
                    </div>
                    {/* Dynamic VibrantJS gradient overlays */}
                    <div
                        className="absolute inset-0"
                        style={{
                            background: colors
                                ? `linear-gradient(to bottom, ${colors.vibrant}30 0%, ${colors.darkVibrant}60 40%, ${colors.darkMuted}90 70%, #0a0a0a 100%)`
                                : "linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.7) 40%, #0a0a0a 100%)",
                        }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-surface via-transparent to-transparent" />
                </div>
            ) : (
                <div
                    className="absolute inset-0"
                    style={{
                        background: colors
                            ? `linear-gradient(to bottom, ${colors.vibrant}40 0%, ${colors.darkVibrant}80 50%, #0a0a0a 100%)`
                            : "linear-gradient(to bottom, #3d2a1e 0%, #1a1a1a 50%, #0a0a0a 100%)",
                    }}
                />
            )}

            <div className="relative mx-auto max-w-[1800px] px-4 pb-5 pt-10 sm:px-6 sm:pb-6 sm:pt-16 lg:px-8">
                <div className="flex flex-col items-center gap-5 text-center sm:flex-row sm:items-end sm:gap-7 sm:text-left">
                    <div className="relative h-36 w-36 shrink-0 overflow-hidden rounded-full bg-surface-highlight shadow-2xl ring-1 ring-white/10 sm:h-48 sm:w-48">
                        {heroImage ? (
                            <Image
                                src={heroImage}
                                alt={displayData.name}
                                fill
                                sizes="(max-width: 640px) 144px, 192px"
                                className="object-cover"
                                priority
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Music className="w-16 h-16 text-gray-400" />
                            </div>
                        )}
                    </div>

                    <div className="min-w-0 w-full flex-1 pb-1">
                        <p className="mb-1 text-xs font-bold uppercase tracking-[0.16em] text-white/75">
                            Artist
                        </p>
                        <div className="group mb-2 flex min-w-0 items-start justify-center gap-3 sm:justify-start">
                            <h1 className="min-w-0 max-w-full text-[clamp(2rem,9vw,4.5rem)] font-black leading-[0.98] tracking-[-0.045em] text-white [overflow-wrap:anywhere]">
                                {displayData.name}
                            </h1>
                            {displayData.hasUserOverrides && (
                                <span className="px-2 py-0.5 text-xs bg-amber-500/20 text-amber-400 rounded-full border border-amber-500/30 shrink-0">
                                    Edited
                                </span>
                            )}
                            {source === "library" && (
                                <Suspense fallback={null}>
                                    <MetadataEditor
                                        type="artist"
                                        id={artist.id}
                                        currentData={{
                                            name: displayData.name,
                                            bio: displayData.summary,
                                            genres: displayData.genres,
                                            mbid: artist.mbid,
                                            heroUrl: displayData.heroUrl,
                                            // Pass originals for reset comparison
                                            _originalName: artist.name,
                                            _originalBio:
                                                artist.summary ?? artist.bio,
                                            _originalGenres:
                                                artist.genres ??
                                                artist.tags ??
                                                [],
                                            _originalHeroUrl:
                                                artist.heroUrl ?? artist.image,
                                            _hasUserOverrides:
                                                displayData.hasUserOverrides,
                                        }}
                                        onSave={async () => {
                                            await onReload();
                                        }}
                                    />
                                </Suspense>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-1 text-sm text-white/70 sm:justify-start">
                            {artist.listeners && artist.listeners > 0 && (
                                <>
                                    <span>
                                        {artist.listeners.toLocaleString()}{" "}
                                        listeners
                                    </span>
                                    <span className="mx-1">•</span>
                                </>
                            )}
                            {albums.length > 0 && (
                                <>
                                    <span>{albums.length} albums</span>
                                    {ownedAlbums.length > 0 && (
                                        <>
                                            <span className="mx-1">•</span>
                                            <span className="text-brand">
                                                {ownedAlbums.length} owned
                                            </span>
                                        </>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {children && (
                <div className="relative mx-auto max-w-[1800px] px-4 pb-5 sm:px-6 lg:px-8">
                    {children}
                </div>
            )}
        </div>
    );
}
