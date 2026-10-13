"use client";

import { useRouter } from "next/navigation";
import Image from "next/image";
import { Mic2 } from "lucide-react";
import { SimilarPodcast } from "../types";
import { api } from "@/lib/api";
import { podcastRu } from "@/lib/i18n/podcastRu";

interface SimilarPodcastsProps {
    podcasts: SimilarPodcast[];
}

// Always proxy images through the backend for caching and mobile compatibility
const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

/**
 * Renders the SimilarPodcasts component.
 */
export function SimilarPodcasts({ podcasts }: SimilarPodcastsProps) {
    const router = useRouter();

    if (!podcasts || podcasts.length === 0) {
        return null;
    }

    return (
        <section>
            <h2 className="mb-4 text-xl font-semibold text-content sm:text-2xl">
                {podcastRu.detail.similar}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {podcasts.map((podcast) => {
                    const imageUrl = getProxiedImageUrl(podcast.coverUrl);
                    return (
                        <button
                            key={podcast.id}
                            type="button"
                            className="group min-w-0 rounded-[14px] p-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                            onClick={() =>
                                router.push(`/podcasts/${podcast.id}`)
                            }
                        >
                            <div className="relative mb-3 aspect-square w-full overflow-hidden rounded-[14px] bg-surface-highlight">
                                {imageUrl ? (
                                    <Image
                                        src={imageUrl}
                                        alt={podcast.title}
                                        fill
                                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                                        className="object-cover"
                                        unoptimized
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Mic2 className="h-10 w-10 text-content-muted" />
                                    </div>
                                )}
                            </div>
                            <h3 className="mb-1 line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-content [overflow-wrap:anywhere] sm:text-base">
                                {podcast.title}
                            </h3>
                            <p className="truncate text-sm text-content-secondary">
                                {podcast.author}
                            </p>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
