"use client";

import { Play, Pause, Check, ArrowUpDown, CheckCircle } from "lucide-react";
import { cn } from "@/utils/cn";
import { Podcast, Episode } from "../types";
import {
    formatEpisodeNumberRu,
    formatPodcastDurationRu,
    formatSeasonRu,
    podcastRu,
} from "@/lib/i18n/podcastRu";
import { formatDate } from "../utils";
import { ru } from "@/lib/i18n/ru";
import { EpisodeOverflowMenu } from "./EpisodeOverflowMenu";

interface EpisodeListProps {
    podcast: Podcast;
    episodes: Episode[];
    sortOrder: "newest" | "oldest";
    onSortOrderChange: (order: "newest" | "oldest") => void;
    isEpisodePlaying: (episodeId: string) => boolean;
    isPlaying: boolean;
    onPlayPause: (episode: Episode) => void;
    onPlay: (episode: Episode) => void;
    onMarkComplete?: (episodeId: string, duration: number) => void;
}

/**
 * Renders the EpisodeList component.
 */
export function EpisodeList({
    podcast,
    episodes,
    sortOrder,
    onSortOrderChange,
    isEpisodePlaying,
    isPlaying,
    onPlayPause,
    onPlay,
    onMarkComplete,
}: EpisodeListProps) {
    return (
        <section>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-semibold text-content sm:text-2xl">
                    {podcastRu.detail.allEpisodes}
                </h2>
                <button
                    onClick={() =>
                        onSortOrderChange(
                            sortOrder === "newest" ? "oldest" : "newest",
                        )
                    }
                    className="flex min-h-11 items-center gap-2 rounded-[10px] bg-surface-raised px-3 py-2 text-sm text-content-secondary transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                >
                    <ArrowUpDown className="w-4 h-4" />
                    {sortOrder === "newest"
                        ? podcastRu.detail.newestFirst
                        : podcastRu.detail.oldestFirst}
                </button>
            </div>

            <div className="space-y-1">
                {episodes.map((episode, index) => {
                    const isCurrentEpisode = isEpisodePlaying(episode.id);
                    const isInProgress =
                        episode.progress &&
                        !episode.progress.isFinished &&
                        episode.progress.currentTime > 0;

                    return (
                        <div
                            key={episode.id}
                            className={cn(
                                "group relative rounded-[10px] transition-colors motion-reduce:transition-none",
                                isCurrentEpisode
                                    ? "bg-surface-active"
                                    : "hover:bg-surface-hover",
                            )}
                        >
                            {/* Progress bar at the bottom */}
                            {episode.progress &&
                                episode.progress.progress > 0 && (
                                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5 rounded-full overflow-hidden">
                                        <div
                                            className="h-full bg-brand/60 transition-all"
                                            style={{
                                                width: `${episode.progress.progress}%`,
                                            }}
                                        />
                                    </div>
                                )}

                            <div
                                role="button"
                                tabIndex={0}
                                aria-label={`${ru.common.play}: ${episode.title}`}
                                onKeyDown={(event) => {
                                    if (
                                        event.target !== event.currentTarget ||
                                        (event.key !== "Enter" &&
                                            event.key !== " ")
                                    )
                                        return;
                                    event.preventDefault();
                                    if (!isCurrentEpisode) onPlay(episode);
                                }}
                                onClick={(event) => {
                                    // Portaled actions belong to this row in React,
                                    // but closing their dialog must not start playback.
                                    if (
                                        !event.currentTarget.contains(
                                            event.target as Node,
                                        )
                                    )
                                        return;
                                    if (!isCurrentEpisode) {
                                        onPlay(episode);
                                    }
                                }}
                                className="flex min-h-16 cursor-pointer items-center gap-2 px-2 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-brand sm:gap-3 sm:px-3"
                            >
                                <button
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onPlayPause(episode);
                                    }}
                                    aria-label={`${isCurrentEpisode && isPlaying ? ru.common.pause : ru.common.play}: ${episode.title}`}
                                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-content-secondary transition-colors hover:bg-surface-active hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                                >
                                    {episode.progress?.isFinished ? (
                                        <Check className="h-4 w-4 text-success" />
                                    ) : isCurrentEpisode && isPlaying ? (
                                        <Pause className="h-4 w-4 text-brand" />
                                    ) : (
                                        <>
                                            <span className="hidden text-sm tabular-nums group-hover:hidden group-focus-within:hidden sm:inline">
                                                {index + 1}
                                            </span>
                                            <Play className="h-4 w-4 sm:hidden sm:group-hover:block sm:group-focus-within:block" />
                                        </>
                                    )}
                                </button>

                                {/* Episode Info */}
                                <div className="flex-1 min-w-0">
                                    <h3
                                        className={cn(
                                            "line-clamp-2 text-sm font-semibold leading-5 [overflow-wrap:anywhere] sm:text-base",
                                            isCurrentEpisode
                                                ? "text-brand"
                                                : "text-content",
                                        )}
                                    >
                                        {episode.title}
                                    </h3>
                                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-content-secondary">
                                        <span>
                                            {formatDate(episode.publishedAt)}
                                        </span>
                                        {episode.season && (
                                            <>
                                                <span>•</span>
                                                <span>
                                                    {formatSeasonRu(
                                                        episode.season,
                                                    )}
                                                </span>
                                            </>
                                        )}
                                        {episode.episodeNumber && (
                                            <>
                                                <span>•</span>
                                                <span>
                                                    {formatEpisodeNumberRu(
                                                        episode.episodeNumber,
                                                    )}
                                                </span>
                                            </>
                                        )}
                                        {episode.progress?.isFinished && (
                                            <>
                                                <span>•</span>
                                                <span className="text-success">
                                                    {podcastRu.detail.finished}
                                                </span>
                                            </>
                                        )}
                                        {isInProgress && episode.progress && (
                                            <>
                                                <span>•</span>
                                                <span className="text-brand">
                                                    {Math.floor(
                                                        episode.progress
                                                            .progress,
                                                    )}
                                                    %
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Duration */}
                                <span className="hidden shrink-0 text-xs tabular-nums text-content-muted sm:inline">
                                    {formatPodcastDurationRu(episode.duration)}
                                </span>

                                {/* Queue actions */}
                                <div>
                                    <EpisodeOverflowMenu
                                        episode={episode}
                                        podcast={{
                                            id: podcast.id,
                                            title: podcast.title,
                                            coverUrl: podcast.coverUrl ?? null,
                                        }}
                                    />
                                </div>

                                {/* Complete Button - visible on hover for incomplete episodes */}
                                {onMarkComplete &&
                                    !episode.progress?.isFinished && (
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onMarkComplete(
                                                    episode.id,
                                                    episode.duration,
                                                );
                                            }}
                                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-content-secondary opacity-100 transition-colors hover:bg-surface-active hover:text-success focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 motion-reduce:transition-none"
                                            title={
                                                podcastRu.detail.markComplete
                                            }
                                        >
                                            <CheckCircle className="h-4 w-4" />
                                        </button>
                                    )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
