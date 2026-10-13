"use client";

import DOMPurify from "dompurify";
import { Plus, Loader2 } from "lucide-react";
import { PodcastPreview } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatPodcastDurationRu, podcastRu } from "@/lib/i18n/podcastRu";
import { formatDate } from "../utils";

interface PreviewEpisodesProps {
    previewData: PodcastPreview;
    colors: ColorPalette | null;
    isSubscribing: boolean;
    onSubscribe: () => void;
}

/**
 * Renders the PreviewEpisodes component.
 */
export function PreviewEpisodes({
    previewData,
    isSubscribing,
    onSubscribe,
}: PreviewEpisodesProps) {
    return (
        <section>
            <h2 className="mb-4 text-xl font-semibold text-content sm:text-2xl">
                {podcastRu.detail.latestEpisodes}
            </h2>

            {/* Episode Preview with Blur/Lock Effect */}
            <div className="relative">
                {previewData.previewEpisodes &&
                previewData.previewEpisodes.length > 0 ? (
                    <>
                        <div className="space-y-1">
                            {previewData.previewEpisodes.map(
                                (episode, index) => (
                                    <div
                                        key={`${episode.publishedAt}-${episode.title}`}
                                        className="flex min-h-16 items-center gap-3 rounded-[10px] px-3 py-3 text-content-secondary"
                                    >
                                        {/* Number */}
                                        <div className="w-8 flex items-center justify-center shrink-0">
                                            <span className="text-sm text-content-muted">
                                                {index + 1}
                                            </span>
                                        </div>

                                        {/* Episode Info */}
                                        <div className="flex-1 min-w-0">
                                            <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-content [overflow-wrap:anywhere]">
                                                {episode.title}
                                            </h3>
                                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-content-secondary">
                                                <span>
                                                    {formatDate(
                                                        episode.publishedAt,
                                                    )}
                                                </span>
                                                {episode.duration > 0 && (
                                                    <>
                                                        <span>•</span>
                                                        <span>
                                                            {formatPodcastDurationRu(
                                                                episode.duration,
                                                            )}
                                                        </span>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ),
                            )}
                        </div>

                        {/* Blur/Fade Overlay with Subscribe CTA */}
                        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-surface/80 to-surface flex items-end justify-center pb-8 pointer-events-none">
                            <button
                                onClick={onSubscribe}
                                disabled={isSubscribing}
                                className="pointer-events-auto flex min-h-12 max-w-full items-center gap-2 rounded-[10px] bg-brand px-4 py-3 text-sm font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 motion-reduce:transition-none"
                            >
                                {isSubscribing ? (
                                    <>
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                        <span>
                                            {podcastRu.detail.subscribing}
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <Plus className="w-5 h-5" />
                                        <span>
                                            {podcastRu.detail.unlockEpisodes}
                                        </span>
                                    </>
                                )}
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="rounded-[14px] bg-surface-raised p-6 text-center">
                        <p className="text-content-secondary mb-4">
                            {podcastRu.detail.previewEmpty}
                        </p>
                        <button
                            onClick={onSubscribe}
                            disabled={isSubscribing}
                            className="mx-auto flex min-h-12 items-center gap-2 rounded-[10px] bg-brand px-5 py-3 font-semibold text-surface transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 motion-reduce:transition-none"
                        >
                            {isSubscribing ? (
                                <>
                                    <Loader2 className="w-5 h-5 animate-spin" />
                                    <span>{podcastRu.detail.subscribing}</span>
                                </>
                            ) : (
                                <>
                                    <Plus className="w-5 h-5" />
                                    <span>{podcastRu.detail.subscribe}</span>
                                </>
                            )}
                        </button>
                    </div>
                )}
            </div>

            {/* About Section */}
            {previewData.description && (
                <div className="mt-8">
                    <h2 className="mb-4 text-xl font-semibold text-content sm:text-2xl">
                        {podcastRu.detail.about}
                    </h2>
                    <div className="rounded-[14px] bg-surface-raised p-4 sm:p-5">
                        <div
                            className="prose prose-invert prose-sm max-w-[70ch] text-content-secondary [overflow-wrap:anywhere] [&_a]:text-brand [&_a]:no-underline [&_a:hover]:underline"
                            dangerouslySetInnerHTML={{
                                __html: DOMPurify.sanitize(
                                    previewData.description || "",
                                ),
                            }}
                        />
                    </div>
                </div>
            )}
        </section>
    );
}
