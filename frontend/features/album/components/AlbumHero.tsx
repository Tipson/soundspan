"use client";

import { Disc3 } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { Album, AlbumSource } from "../types";
import { ReactNode, lazy, Suspense } from "react";
import { useAlbumDisplayData } from "@/hooks/useMetadataDisplay";
import type { ColorPalette } from "@/hooks/useImageColor";
import { getArtistHref } from "@/utils/artistRoute";
import { formatDuration } from "@/utils/formatTime";
import { MusicDetailHero } from "@/components/music-detail";
import { pluralRu, ru } from "@/lib/i18n/ru";

// Lazy load MetadataEditor - modal component opened on user action
const MetadataEditor = lazy(() =>
    import("@/components/MetadataEditor").then((mod) => ({
        default: mod.MetadataEditor,
    })),
);

interface AlbumHeroProps {
    album: Album;
    source: AlbumSource;
    coverUrl: string | null;
    colors: ColorPalette | null;
    onReload: () => void;
    children?: ReactNode;
}

/**
 * Renders the AlbumHero component.
 */
export function AlbumHero({
    album,
    source,
    coverUrl,
    colors,
    onReload,
    children,
}: AlbumHeroProps) {
    const displayData = useAlbumDisplayData(album);
    const totalDuration = album.duration ? formatDuration(album.duration) : "";
    const artistHref =
        getArtistHref({
            id: album.artist?.id,
            mbid: album.artist?.mbid,
            name: album.artist?.name,
        }) || "/artist";

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
                        type="album"
                        id={album.id}
                        currentData={{
                            title: displayData.title,
                            year: displayData.year,
                            genres: displayData.genres,
                            rgMbid: album.rgMbid || album.mbid,
                            coverUrl: displayData.coverUrl,
                            _originalTitle: album.title,
                            _originalYear: album.year,
                            _originalGenres: album.genre ? [album.genre] : [],
                            _originalCoverUrl: album.coverUrl,
                            _hasUserOverrides: displayData.hasUserOverrides,
                        }}
                        artistName={album.artist?.name}
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
            {album.artist && (
                <Link
                    href={artistHref}
                    className="font-bold text-white hover:underline"
                >
                    {album.artist.name}
                </Link>
            )}
            {displayData.year && (
                <>
                    <span aria-hidden="true">•</span>
                    <span>{displayData.year}</span>
                </>
            )}
            {album.trackCount && album.trackCount > 0 && (
                <>
                    <span aria-hidden="true">•</span>
                    <span>
                        {album.trackCount}{" "}
                        {pluralRu(album.trackCount, [
                            "трек",
                            "трека",
                            "треков",
                        ])}
                    </span>
                </>
            )}
            {totalDuration && (
                <>
                    <span aria-hidden="true">•</span>
                    <span>{totalDuration}</span>
                </>
            )}
            {album.genre && (
                <span className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-xs text-white/75">
                    {album.genre}
                </span>
            )}
        </>
    );

    return (
        <MusicDetailHero
            eyebrow={ru.catalog.album}
            title={displayData.title}
            artworkShape="square"
            backgroundImage={coverUrl}
            ambientColors={colors}
            titleAfter={titleAfter}
            metadata={metadata}
            actions={children}
            artwork={
                coverUrl ? (
                    <Image
                        src={coverUrl}
                        alt={album.title}
                        fill
                        sizes="(max-width: 640px) 176px, (max-width: 1024px) 208px, 224px"
                        className="object-cover"
                        priority
                        unoptimized
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center">
                        <Disc3 className="h-16 w-16 text-content-muted" />
                    </div>
                )
            }
        />
    );
}
