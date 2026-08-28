"use client";

import { useId, useMemo } from "react";
import Image from "next/image";
import { Music, Play, Radio } from "lucide-react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import type { Track } from "@/lib/audio-state-context";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import type { PersonalizedTrack } from "../types";
import { useOptionalDeviceOffline } from "@/features/device-offline/DeviceOfflineProvider";
import { getDeviceDownloadSourceUrl } from "@/features/device-offline/sourceUrl";
import { toast } from "sonner";

interface PersonalizedTrackShelfProps {
    title: string;
    subtitle?: string;
    tracks: PersonalizedTrack[];
}

function toPlaybackTrack(track: PersonalizedTrack): Track {
    const youtubeVideoId =
        track.youtubeVideoId || track.provider.youtubeVideoId;
    return {
        id: `yt:${youtubeVideoId}`,
        title: track.title,
        artist: {
            name: track.artist.name,
            ...(track.artist.id ? { id: track.artist.id } : {}),
        },
        album: {
            title: track.album.title,
            coverArt: track.album.coverArt,
            ...(track.album.id ? { id: track.album.id } : {}),
        },
        duration: track.duration,
        source: "youtube",
        provider: {
            source: "youtube",
            youtubeVideoId,
        },
        streamSource: "youtube",
        youtubeVideoId,
    };
}

function trackImageUrl(track: PersonalizedTrack): string | null {
    return track.album.coverArt
        ? api.getCoverArtUrl(track.album.coverArt, 160)
        : null;
}

function PersonalizedDownloadAction({ track }: { track: Track }) {
    const deviceOffline = useOptionalDeviceOffline();
    if (!deviceOffline) return null;
    const record = deviceOffline.recordForTrack(track);
    const busy = record?.status === "downloading";
    const ready = record?.status === "ready";

    return (
        <button
            type="button"
            disabled={busy || ready}
            onClick={() => {
                void deviceOffline
                    .download({
                        track,
                        quality: "auto",
                        sourceUrl: getDeviceDownloadSourceUrl(track),
                    })
                    .then((record) =>
                        toast.success(
                            record.status === "ready"
                                ? `"${track.title}" is available offline`
                                : `Download started for "${track.title}"`,
                        ),
                    )
                    .catch((error: unknown) =>
                        toast.error(
                            error instanceof Error
                                ? error.message
                                : "Device download failed",
                        ),
                    );
            }}
            aria-label={
                ready
                    ? `${track.title} is available offline`
                    : busy
                      ? `Downloading ${track.title}`
                      : `Download ${track.title} to this device`
            }
            title={ready ? "Available offline" : "Download to device"}
            className="mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-full text-lg text-white/65 transition hover:bg-white/10 hover:text-white disabled:opacity-55"
        >
            <span aria-hidden="true">{ready ? "✓" : busy ? "…" : "↓"}</span>
        </button>
    );
}

/** Immediate-play, two-row shelf for the user's personal catalog. */
export function PersonalizedTrackShelf({
    title,
    subtitle,
    tracks,
}: PersonalizedTrackShelfProps) {
    const titleId = useId();
    const { playTracks } = useAudioControls();
    const queue = useMemo(() => tracks.map(toPlaybackTrack), [tracks]);

    if (tracks.length === 0) return null;

    return (
        <section
            aria-labelledby={titleId}
            className="relative overflow-hidden rounded-2xl border border-white/8 bg-gradient-to-br from-white/[0.075] via-white/[0.035] to-brand/[0.08] p-4 sm:p-5"
        >
            <div className="mb-4 flex items-end justify-between gap-4">
                <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                        <h2
                            id={titleId}
                            className="truncate text-xl font-bold tracking-tight text-white sm:text-2xl"
                        >
                            {title}
                        </h2>
                        <YouTubeBadge />
                    </div>
                    {subtitle && (
                        <p className="mt-1 text-sm text-white/55">{subtitle}</p>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => playTracks(queue, 0)}
                    className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-bold text-black shadow-lg shadow-brand/15 transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                    aria-label={`Play all ${title}`}
                >
                    <Radio className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Play all</span>
                </button>
            </div>

            <div
                role="list"
                className="grid grid-flow-col grid-rows-2 auto-cols-[minmax(260px,82vw)] gap-2 overflow-x-auto pb-1 sm:auto-cols-[minmax(300px,380px)]"
            >
                {tracks.map((track, index) => {
                    const imageUrl = trackImageUrl(track);
                    return (
                        <div
                            key={`${track.id}-${index}`}
                            role="listitem"
                            className="group flex min-h-[68px] items-center overflow-hidden rounded-xl border border-white/[0.055] bg-black/25 transition hover:border-white/15 hover:bg-white/[0.09]"
                        >
                            <button
                                type="button"
                                onClick={() => playTracks(queue, index)}
                                aria-label={`Play ${track.title} by ${track.artist.name}`}
                                className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                            >
                                <span className="relative h-13 w-13 shrink-0 overflow-hidden rounded-lg bg-white/[0.07] shadow-md">
                                    {imageUrl ? (
                                        <Image
                                            src={imageUrl}
                                            alt=""
                                            fill
                                            sizes="52px"
                                            className="object-cover transition duration-300 group-hover:scale-105"
                                            unoptimized
                                        />
                                    ) : (
                                        <span className="flex h-full w-full items-center justify-center">
                                            <Music
                                                className="h-5 w-5 text-white/35"
                                                aria-hidden="true"
                                            />
                                        </span>
                                    )}
                                    <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                                        <Play
                                            className="h-5 w-5 fill-white text-white"
                                            aria-hidden="true"
                                        />
                                    </span>
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-semibold text-white">
                                        {track.title}
                                    </span>
                                    <span className="mt-0.5 block truncate text-xs text-white/50">
                                        {track.artist.name}
                                        {track.album.title &&
                                        track.album.title !== "Single"
                                            ? ` · ${track.album.title}`
                                            : ""}
                                    </span>
                                </span>
                                <Play
                                    className="mr-1 h-4 w-4 shrink-0 fill-white/70 text-white/70 sm:hidden"
                                    aria-hidden="true"
                                />
                            </button>
                            <PersonalizedDownloadAction track={queue[index]} />
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
