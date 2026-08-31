"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import { Music, Play } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { useAudioControls } from "@/lib/audio-controls-context";
import { toProviderPlaybackTrack } from "@/lib/audio/providerRadioContinuation";
import { api } from "@/lib/api";
import type { PersonalizedTrack } from "../types";

interface HomeListeningDashboardProps {
    tracks: PersonalizedTrack[];
    children?: ReactNode;
}

function trackKey(track: PersonalizedTrack): string {
    return track.youtubeVideoId || track.provider.youtubeVideoId || track.id;
}

function coverUrl(track: PersonalizedTrack, size: number): string | null {
    return track.album.coverArt
        ? api.getCoverArtUrl(track.album.coverArt, size)
        : null;
}

function ArtworkFallback({ title }: { title: string }) {
    return (
        <span
            role="img"
            aria-label={`Обложка для «${title}» недоступна`}
            className="absolute inset-0 grid place-items-center bg-white/[0.055]"
        >
            <Music className="h-5 w-5 text-white/35" aria-hidden="true" />
        </span>
    );
}

/**
 * One listening queue presented as two complementary regions: large resume
 * cards and a compact recency list. A track is never repeated across regions.
 */
export function HomeListeningDashboard({
    tracks,
    children,
}: HomeListeningDashboardProps) {
    const { playTracks } = useAudioControls();
    const uniqueTracks = useMemo(() => {
        const seen = new Set<string>();
        return tracks.filter((track) => {
            const key = trackKey(track);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }, [tracks]);
    const queue = useMemo(
        () => uniqueTracks.map(toProviderPlaybackTrack),
        [uniqueTracks],
    );
    const continuationCount =
        uniqueTracks.length > 4
            ? 4
            : uniqueTracks.length > 1
              ? uniqueTracks.length - 1
              : uniqueTracks.length;
    const continuation = uniqueTracks.slice(0, continuationCount);
    const recent = uniqueTracks.slice(continuationCount, continuationCount + 5);

    if (uniqueTracks.length === 0) {
        return children ? (
            <div data-home-region="listening-dashboard">{children}</div>
        ) : null;
    }

    const playAt = (index: number) => playTracks(queue, index);

    return (
        <div
            data-home-region="listening-dashboard"
            className="relative z-10 grid min-w-0 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]"
        >
            <div className="min-w-0 space-y-9">
                <section
                    data-home-region="continue-listening"
                    aria-labelledby="home-continue-title"
                    className="min-w-0"
                >
                    <div className="mb-4 flex items-center justify-between gap-4">
                        <h2
                            id="home-continue-title"
                            className="text-xl font-bold tracking-[-0.025em] text-content"
                        >
                            Продолжить слушать
                        </h2>
                    </div>
                    <div
                        role="list"
                        className="scrollbar-hide grid snap-x snap-mandatory grid-flow-col auto-cols-[minmax(210px,72vw)] gap-4 overflow-x-auto overscroll-x-contain pb-1 md:auto-cols-[minmax(220px,1fr)] xl:grid-flow-row xl:grid-cols-4 xl:overflow-visible"
                    >
                        {continuation.map((track, index) => (
                            <article
                                key={trackKey(track)}
                                role="listitem"
                                data-track-id={track.id}
                                className="group min-w-0 snap-start"
                            >
                                <button
                                    type="button"
                                    onClick={() => playAt(index)}
                                    aria-label={`Воспроизвести «${track.title}», исполнитель ${track.artist.name}`}
                                    className="block w-full rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
                                >
                                    <span className="relative block aspect-[1.08/1] overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.04] shadow-[0_18px_48px_rgba(0,0,0,0.22)]">
                                        {coverUrl(track, 520) ? (
                                            <CachedImage
                                                src={coverUrl(track, 520)}
                                                alt=""
                                                fill
                                                sizes="(min-width: 1280px) 20vw, 220px"
                                                className="object-cover transition duration-300 group-hover:scale-[1.025] motion-reduce:transition-none"
                                                fallback={
                                                    <ArtworkFallback
                                                        title={track.title}
                                                    />
                                                }
                                            />
                                        ) : (
                                            <ArtworkFallback
                                                title={track.title}
                                            />
                                        )}
                                        <span className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/5 to-transparent" />
                                        <span className="absolute bottom-3 right-3 grid h-10 w-10 translate-y-1 place-items-center rounded-full bg-white text-black opacity-0 shadow-xl transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100 motion-reduce:transition-none">
                                            <Play
                                                className="ml-0.5 h-4 w-4 fill-current"
                                                aria-hidden="true"
                                            />
                                        </span>
                                    </span>
                                    <span className="mt-2.5 block truncate text-sm font-semibold text-content">
                                        {track.title}
                                    </span>
                                    <span className="mt-0.5 block truncate text-xs text-content-muted">
                                        {track.artist.name}
                                    </span>
                                </button>
                            </article>
                        ))}
                    </div>
                </section>
                {children}
            </div>

            {recent.length > 0 && (
                <section
                    data-home-region="recently-played"
                    aria-labelledby="home-recent-title"
                    className="min-w-0"
                >
                    <div className="mb-4 flex items-center justify-between gap-4">
                        <h2
                            id="home-recent-title"
                            className="text-xl font-bold tracking-[-0.025em] text-content"
                        >
                            Недавно слушали
                        </h2>
                    </div>
                    <div role="list" className="grid gap-1.5">
                        {recent.map((track, recentIndex) => {
                            const queueIndex = continuationCount + recentIndex;
                            return (
                                <div
                                    key={trackKey(track)}
                                    role="listitem"
                                    data-track-id={track.id}
                                >
                                    <button
                                        type="button"
                                        onClick={() => playAt(queueIndex)}
                                        aria-label={`Воспроизвести «${track.title}», исполнитель ${track.artist.name}`}
                                        className="group flex min-h-14 w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition hover:bg-white/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand motion-reduce:transition-none"
                                    >
                                        <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-white/[0.055]">
                                            {coverUrl(track, 120) ? (
                                                <CachedImage
                                                    src={coverUrl(track, 120)}
                                                    alt=""
                                                    fill
                                                    sizes="48px"
                                                    className="object-cover"
                                                    fallback={
                                                        <ArtworkFallback
                                                            title={track.title}
                                                        />
                                                    }
                                                />
                                            ) : (
                                                <ArtworkFallback
                                                    title={track.title}
                                                />
                                            )}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-semibold text-content">
                                                {track.title}
                                            </span>
                                            <span className="mt-0.5 block truncate text-xs text-content-muted">
                                                {track.artist.name}
                                            </span>
                                        </span>
                                        <Play
                                            className="h-4 w-4 shrink-0 fill-current text-content-subtle opacity-0 transition group-hover:opacity-100 motion-reduce:transition-none"
                                            aria-hidden="true"
                                        />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </section>
            )}
        </div>
    );
}
