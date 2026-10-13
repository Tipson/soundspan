"use client";

import { Mic2 } from "lucide-react";
import Image from "next/image";
import { ReactNode } from "react";
import { MusicDetailHero } from "@/components/music-detail";
import type { ColorPalette } from "@/hooks/useImageColor";
import {
    formatEpisodeCountRu,
    formatInProgressRu,
    podcastRu,
} from "@/lib/i18n/podcastRu";

interface PodcastHeroProps {
    title: string;
    author: string;
    description?: string;
    genres?: string[];
    heroImage: string | null;
    colors: ColorPalette | null;
    episodeCount: number;
    inProgressCount: number;
    children?: ReactNode;
}

function podcastDescriptionText(description: string): string {
    let tagDepth = 0;
    let text = "";
    for (const character of description) {
        if (character === "<") {
            tagDepth += 1;
        } else if (character === ">") {
            tagDepth = Math.max(0, tagDepth - 1);
        } else if (tagDepth === 0) {
            text += character;
        }
    }
    return text.slice(0, 150);
}

/**
 * Renders the PodcastHero component.
 */
export function PodcastHero({
    title,
    author,
    description,
    genres,
    heroImage,
    colors,
    episodeCount,
    inProgressCount,
    children,
}: PodcastHeroProps) {
    return (
        <MusicDetailHero
            eyebrow={podcastRu.detail.type}
            title={title}
            artworkShape="square"
            ambientColors={colors}
            backgroundImage={heroImage}
            artwork={
                heroImage ? (
                    <Image
                        src={heroImage}
                        alt={title}
                        fill
                        sizes="(max-width: 640px) 160px, (max-width: 1024px) 192px, 224px"
                        className="object-cover"
                        priority
                        unoptimized
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center">
                        <Mic2 className="h-16 w-16 text-content-muted" />
                    </div>
                )
            }
            metadata={
                <>
                    <span className="font-semibold text-content">{author}</span>
                    <span aria-hidden="true">•</span>
                    <span>{formatEpisodeCountRu(episodeCount)}</span>
                    {inProgressCount > 0 && (
                        <>
                            <span aria-hidden="true">•</span>
                            <span className="text-brand">
                                {formatInProgressRu(inProgressCount)}
                            </span>
                        </>
                    )}
                </>
            }
            description={
                <>
                    {description && (
                        <p className="line-clamp-2">
                            {podcastDescriptionText(description)}...
                        </p>
                    )}
                    {genres && genres.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                            {genres.slice(0, 4).map((genre) => (
                                <span
                                    key={genre}
                                    className="rounded-full bg-surface-active px-2.5 py-1 text-xs text-content-secondary"
                                >
                                    {genre}
                                </span>
                            ))}
                        </div>
                    )}
                </>
            }
            actions={children}
        />
    );
}
