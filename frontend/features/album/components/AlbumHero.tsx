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

    return (
        <div className="relative">
            {/* Background Image with VibrantJS gradient */}
            {coverUrl ? (
                <div className="absolute inset-0 overflow-hidden">
                    <div className="absolute inset-0 scale-110 blur-md opacity-50">
                        <Image
                            src={coverUrl}
                            alt={album.title}
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
                    <div className="relative h-44 w-44 shrink-0 overflow-hidden rounded-2xl bg-surface-highlight shadow-2xl ring-1 ring-white/10 sm:h-48 sm:w-48">
                        {coverUrl ? (
                            <Image
                                src={coverUrl}
                                alt={album.title}
                                fill
                                sizes="(max-width: 640px) 176px, 192px"
                                className="object-cover"
                                priority
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Disc3 className="w-16 h-16 text-gray-400" />
                            </div>
                        )}
                    </div>

                    <div className="min-w-0 w-full flex-1 pb-1">
                        <p className="mb-1 text-xs font-bold uppercase tracking-[0.16em] text-white/75">
                            Album
                        </p>
                        <div className="group mb-2 flex min-w-0 items-start justify-center gap-2 sm:justify-start">
                            <h1 className="min-w-0 max-w-full text-[clamp(2rem,9vw,4.5rem)] font-black leading-[0.98] tracking-[-0.045em] text-white [overflow-wrap:anywhere]">
                                {displayData.title}
                            </h1>
                            {displayData.hasUserOverrides && (
                                <span className="px-2 py-0.5 text-xs bg-amber-500/20 text-amber-400 rounded-full border border-amber-500/30 shrink-0">
                                    Edited
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
                                            // Pass originals for reset comparison
                                            _originalTitle: album.title,
                                            _originalYear: album.year,
                                            _originalGenres: album.genre
                                                ? [album.genre]
                                                : [],
                                            _originalCoverUrl: album.coverUrl,
                                            _hasUserOverrides:
                                                displayData.hasUserOverrides,
                                        }}
                                        artistName={album.artist?.name}
                                        onSave={async () => {
                                            await onReload();
                                        }}
                                    />
                                </Suspense>
                            )}
                        </div>
                        <div className="mb-1 flex flex-wrap items-center justify-center gap-1 text-sm text-white/70 sm:justify-start">
                            {album.artist && (
                                <Link
                                    href={artistHref}
                                    className="font-medium text-white hover:underline"
                                >
                                    {album.artist.name}
                                </Link>
                            )}
                            {displayData.year && (
                                <>
                                    <span className="mx-1">•</span>
                                    <span>{displayData.year}</span>
                                </>
                            )}
                            {album.trackCount && album.trackCount > 0 && (
                                <>
                                    <span className="mx-1">•</span>
                                    <span>{album.trackCount} songs</span>
                                </>
                            )}
                            {totalDuration && <span>, {totalDuration}</span>}
                        </div>
                        {album.genre && (
                            <span className="inline-block px-2 py-0.5 bg-white/10 rounded-full text-xs text-white/70">
                                {album.genre}
                            </span>
                        )}
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
