"use client";

import { useMemo } from "react";
import { Music2, Play } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import type { PersonalizedTrack } from "../types";

interface PersonalizedMixCardProps {
    title: string;
    description: string;
    tracks: PersonalizedTrack[];
    tone: "violet" | "blue" | "amber";
    index: number;
}

const toneClasses: Record<PersonalizedMixCardProps["tone"], string> = {
    violet: "from-brand/45 via-ai/20 to-surface-highlight",
    blue: "from-info/40 via-brand/15 to-surface-highlight",
    amber: "from-warning/35 via-brand/10 to-surface-highlight",
};

/** A playable, account-specific collection card backed by a real feed shelf. */
export function PersonalizedMixCard({
    title,
    description,
    tracks,
    tone,
    index,
}: PersonalizedMixCardProps) {
    const { playTracks } = useAudioControls();
    const queue = useMemo(() => tracks.map(toProviderPlaybackTrack), [tracks]);
    const covers = useMemo(
        () =>
            Array.from(
                new Set(
                    tracks
                        .map((track) => track.album.coverArt)
                        .filter((cover): cover is string => Boolean(cover)),
                ),
            ).slice(0, 4),
        [tracks],
    );

    if (queue.length === 0) return null;

    return (
        <button
            type="button"
            onClick={() => playTracks(queue, 0)}
            aria-label={`Play ${title}`}
            data-tv-card
            data-tv-card-index={index}
            className="group block w-full min-w-0 rounded-[1.125rem] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        >
            <span
                className={`relative mb-3 grid aspect-square overflow-hidden rounded-[1.125rem] bg-gradient-to-br ${toneClasses[tone]} shadow-lg shadow-black/25`}
            >
                {covers.length > 0 ? (
                    <span className="absolute inset-0 grid grid-cols-2 grid-rows-2">
                        {covers.map((cover, coverIndex) => (
                            <span
                                key={cover}
                                data-personal-mix-cover
                                className={`relative overflow-hidden ${covers.length === 1 ? "col-span-2 row-span-2" : covers.length === 2 || (covers.length === 3 && coverIndex === 0) ? "row-span-2" : ""}`}
                            >
                                <CachedImage
                                    src={api.getCoverArtUrl(cover, 240)}
                                    alt=""
                                    fill
                                    sizes="(max-width: 640px) 72vw, 190px"
                                    className="object-cover transition duration-300 group-hover:scale-[1.035] motion-reduce:transition-none"
                                />
                            </span>
                        ))}
                    </span>
                ) : (
                    <Music2
                        className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 text-white/55"
                        aria-hidden="true"
                    />
                )}
                <span className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-white/[0.04]" />
                <span className="absolute bottom-3 right-3 grid h-11 w-11 translate-y-1 place-items-center rounded-full bg-content text-surface opacity-0 shadow-xl transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 motion-reduce:transition-none sm:h-12 sm:w-12">
                    <Play
                        className="ml-0.5 h-5 w-5 fill-current"
                        aria-hidden="true"
                    />
                </span>
            </span>
            <span className="block truncate text-sm font-bold text-content sm:text-[0.9375rem]">
                {title}
            </span>
            <span className="mt-1 block text-xs leading-5 text-content-muted">
                {tracks.length} {tracks.length === 1 ? "track" : "tracks"} ·{" "}
                {description}
            </span>
        </button>
    );
}
