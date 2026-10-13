"use client";

import { Play, Pause, Loader2 } from "lucide-react";
import { Podcast, Episode } from "../types";
import { formatPodcastDurationRu, podcastRu } from "@/lib/i18n/podcastRu";
import { formatDate } from "../utils";
import { ru } from "@/lib/i18n/ru";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";

interface ContinueListeningProps {
    podcast: Podcast;
    inProgressEpisodes: Episode[];
    sortedEpisodes: Episode[];
    isEpisodePlaying: (episodeId: string) => boolean;
    isPlaying: boolean;
    onPlayEpisode: (episode: Episode) => void;
    onPlayPause: (episode: Episode) => void;
}

/**
 * Renders the ContinueListening component.
 */
export function ContinueListening({
    podcast: _podcast,
    inProgressEpisodes,
    sortedEpisodes,
    isEpisodePlaying,
    isPlaying,
    onPlayEpisode,
    onPlayPause,
}: ContinueListeningProps) {
    const { showSpinner, triggerPlayFeedback } = usePlayButtonFeedback();

    if (inProgressEpisodes.length === 0) {
        return null;
    }

    // Get the most recently played episode
    const recentEpisode = inProgressEpisodes.reduce((prev, current) => {
        const prevDate = new Date(prev.progress?.lastPlayedAt || 0);
        const currentDate = new Date(current.progress?.lastPlayedAt || 0);
        return currentDate > prevDate ? current : prev;
    });

    // Find the index in sorted episodes
    const currentIndex = sortedEpisodes.findIndex(
        (ep) => ep.id === recentEpisode.id,
    );
    const previousEpisode =
        currentIndex > 0 ? sortedEpisodes[currentIndex - 1] : null;
    const nextEpisode =
        currentIndex < sortedEpisodes.length - 1
            ? sortedEpisodes[currentIndex + 1]
            : null;

    const isCurrentPlaying = isEpisodePlaying(recentEpisode.id);
    const handleCurrentEpisodePlayPause = () => {
        triggerPlayFeedback();
        onPlayPause(recentEpisode);
    };

    return (
        <section>
            <h2 className="mb-4 text-xl font-semibold text-content sm:text-2xl">
                {podcastRu.detail.continueListening}
            </h2>
            <div className="space-y-2">
                {/* Previous Episode - Faded */}
                {previousEpisode && (
                    <button
                        type="button"
                        className="flex min-h-16 w-full items-center gap-3 rounded-[10px] p-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                        onClick={() => onPlayEpisode(previousEpisode)}
                    >
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-surface-raised">
                            <Play className="h-4 w-4 text-content-secondary" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-content [overflow-wrap:anywhere]">
                                {previousEpisode.title}
                            </h3>
                            <p className="mt-1 text-xs text-content-secondary">
                                {podcastRu.detail.previousEpisode}
                            </p>
                        </div>
                    </button>
                )}

                {/* Current Episode - Prominent */}
                <button
                    type="button"
                    aria-label={`${isCurrentPlaying && isPlaying ? ru.common.pause : ru.common.play}: ${recentEpisode.title}`}
                    className="flex min-h-20 w-full items-center gap-3 rounded-[14px] bg-surface-active p-4 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                    onClick={handleCurrentEpisodePlayPause}
                >
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand text-surface">
                        {showSpinner ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                        ) : isCurrentPlaying && isPlaying ? (
                            <Pause className="h-5 w-5" />
                        ) : (
                            <Play
                                className="ml-0.5 h-5 w-5"
                                fill="currentColor"
                            />
                        )}
                    </span>
                    <div className="flex-1 min-w-0">
                        <h3 className="line-clamp-2 font-semibold leading-6 text-content [overflow-wrap:anywhere]">
                            {recentEpisode.title}
                        </h3>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-content-secondary">
                            <span>
                                {formatPodcastDurationRu(
                                    recentEpisode.duration,
                                )}
                            </span>
                            <span>•</span>
                            <span>{formatDate(recentEpisode.publishedAt)}</span>
                        </div>
                        {/* Progress Bar */}
                        {recentEpisode.progress && (
                            <div className="mt-2">
                                <div className="flex items-center gap-2">
                                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-highlight">
                                        <div
                                            className="h-full bg-brand rounded-full transition-all"
                                            style={{
                                                width: `${recentEpisode.progress.progress}%`,
                                            }}
                                        />
                                    </div>
                                    <span className="text-xs text-brand">
                                        {Math.floor(
                                            recentEpisode.progress.progress,
                                        )}
                                        %
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                </button>

                {/* Next Episode - Faded */}
                {nextEpisode && (
                    <button
                        type="button"
                        className="flex min-h-16 w-full items-center gap-3 rounded-[10px] p-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                        onClick={() => onPlayEpisode(nextEpisode)}
                    >
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-surface-raised">
                            <Play className="h-4 w-4 text-content-secondary" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-content [overflow-wrap:anywhere]">
                                {nextEpisode.title}
                            </h3>
                            <p className="mt-1 text-xs text-content-secondary">
                                {podcastRu.detail.nextEpisode}
                            </p>
                        </div>
                    </button>
                )}
            </div>
        </section>
    );
}
