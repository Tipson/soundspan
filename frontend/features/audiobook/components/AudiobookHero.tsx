"use client";

import { Book } from "lucide-react";
import Image from "next/image";
import { ReactNode } from "react";
import { MusicDetailHero } from "@/components/music-detail";
import type { Audiobook } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";

interface AudiobookHeroProps {
    audiobook: Audiobook;
    heroImage: string | null;
    colors: ColorPalette | null;
    metadata: {
        narrator: string | null;
        genre: string | null;
        publishedYear: string | null;
        description: string | null;
    } | null;
    formatTime: (seconds: number) => string;
    children?: ReactNode;
}

/**
 * Renders the AudiobookHero component.
 */
export function AudiobookHero({
    audiobook,
    heroImage,
    colors,
    metadata,
    formatTime,
    children,
}: AudiobookHeroProps) {
    const progressPercent = audiobook.progress?.progress || 0;
    const isFinished = audiobook.progress?.isFinished;

    return (
        <MusicDetailHero
            eyebrow="Аудиокнига"
            title={audiobook.title}
            artworkShape="portrait"
            ambientColors={colors}
            backgroundImage={heroImage}
            artwork={
                heroImage ? (
                    <Image
                        src={heroImage}
                        alt={audiobook.title}
                        fill
                        sizes="(max-width: 640px) 144px, (max-width: 1024px) 176px, 192px"
                        className="object-cover"
                        priority
                        unoptimized
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center">
                        <Book className="h-16 w-16 text-content-muted" />
                    </div>
                )
            }
            metadata={
                <>
                    <span className="font-semibold text-content">
                        {audiobook.author}
                    </span>
                    {metadata?.narrator && (
                        <>
                            <span aria-hidden="true">•</span>
                            <span>{metadata.narrator}</span>
                        </>
                    )}
                    <span aria-hidden="true">•</span>
                    <span>{formatTime(audiobook.duration)}</span>
                    <span aria-hidden="true">•</span>
                    <span
                        className={isFinished ? "text-success" : "text-brand"}
                    >
                        {isFinished
                            ? "Прослушано"
                            : `${Math.round(progressPercent)}% прослушано`}
                    </span>
                </>
            }
            description={
                audiobook.series || (audiobook.genres?.length ?? 0) > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                        {audiobook.series && (
                            <span className="rounded-full bg-surface-active px-2.5 py-1 text-xs text-content-secondary">
                                {audiobook.series.name} #
                                {audiobook.series.sequence}
                            </span>
                        )}
                        {audiobook.genres?.slice(0, 3).map((genre) => (
                            <span
                                key={genre}
                                className="rounded-full bg-surface-active px-2.5 py-1 text-xs text-content-secondary"
                            >
                                {genre}
                            </span>
                        ))}
                    </div>
                ) : undefined
            }
            actions={children}
        />
    );
}
