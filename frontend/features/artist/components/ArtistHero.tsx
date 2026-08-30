"use client";

import { Music } from "lucide-react";
import Image from "next/image";
import { Artist, ArtistSource, Album } from "../types";
import { ReactNode, lazy, Suspense } from "react";
import { useArtistDisplayData } from "@/hooks/useMetadataDisplay";
import type { ColorPalette } from "@/hooks/useImageColor";
import { MusicDetailHero } from "@/components/music-detail";
import { pluralRu, ru } from "@/lib/i18n/ru";

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

    const titleAfter = (
        <>
            {displayData.hasUserOverrides && (
                <span className="mt-1 shrink-0 rounded-full border border-amber-500/30 bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">
                    {ru.catalog.edited}
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
                            _originalName: artist.name,
                            _originalBio: artist.summary ?? artist.bio,
                            _originalGenres: artist.genres ?? artist.tags ?? [],
                            _originalHeroUrl: artist.heroUrl ?? artist.image,
                            _hasUserOverrides: displayData.hasUserOverrides,
                        }}
                        onSave={async () => {
                            await onReload();
                        }}
                    />
                </Suspense>
            )}
        </>
    );

    const metadata = (
        <>
            {artist.listeners && artist.listeners > 0 && (
                <span>{artist.listeners.toLocaleString("ru-RU")} {ru.catalog.listeners}</span>
            )}
            {artist.listeners && artist.listeners > 0 && albums.length > 0 && (
                <span aria-hidden="true">•</span>
            )}
            {albums.length > 0 && (
                <span>
                    {albums.length} {pluralRu(albums.length, ["альбом", "альбома", "альбомов"])}
                </span>
            )}
            {ownedAlbums.length > 0 && (
                <>
                    <span aria-hidden="true">•</span>
                    <span className="text-brand-light">
                        {ownedAlbums.length} {ru.catalog.savedLocally}
                    </span>
                </>
            )}
        </>
    );

    return (
        <MusicDetailHero
            eyebrow={ru.catalog.artist}
            title={displayData.name}
            artworkShape="round"
            backgroundImage={bgImage}
            ambientColors={colors}
            titleAfter={titleAfter}
            metadata={metadata}
            actions={children}
            artwork={
                heroImage ? (
                    <Image
                        src={heroImage}
                        alt={displayData.name}
                        fill
                        sizes="(max-width: 640px) 176px, (max-width: 1024px) 208px, 224px"
                        className="object-cover"
                        priority
                        unoptimized
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center">
                        <Music className="h-16 w-16 text-content-muted" />
                    </div>
                )
            }
        />
    );
}
