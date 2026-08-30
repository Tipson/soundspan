import Link from "next/link";
import { ListMusic, RotateCcw, Upload } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { api } from "@/lib/api";
import type { PersonalPlaylist } from "../types";

interface PersonalPlaylistGridProps {
    playlists: PersonalPlaylist[];
    isLoading: boolean;
    isError: boolean;
    onRetry?: () => void;
}

function playlistCovers(playlist: PersonalPlaylist): string[] {
    const seen = new Set<string>();
    const covers: string[] = [];
    for (const item of playlist.items ?? []) {
        const cover = item.track?.album?.coverArt?.trim();
        if (!cover || seen.has(cover)) continue;
        seen.add(cover);
        covers.push(api.getCoverArtUrl(cover, 240));
        if (covers.length === 4) break;
    }
    return covers;
}

function PlaylistCover({ playlist }: { playlist: PersonalPlaylist }) {
    const covers = playlistCovers(playlist);
    if (covers.length === 0) {
        return (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand/20 via-ai/10 to-surface-highlight">
                <ListMusic className="h-11 w-11 text-brand-light" />
            </div>
        );
    }

    return (
        <div className="grid h-full w-full grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
                <div
                    key={`${playlist.id}-${index}`}
                    className="relative bg-surface-highlight"
                >
                    {covers[index] && (
                        <CachedImage
                            src={covers[index]}
                            alt=""
                            fill
                            sizes="120px"
                            className="object-cover"
                        />
                    )}
                </div>
            ))}
        </div>
    );
}

/** User-owned playlist cards for the personal Library. */
export function PersonalPlaylistGrid({
    playlists,
    isLoading,
    isError,
    onRetry,
}: PersonalPlaylistGridProps) {
    if (isLoading) {
        return (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
                {Array.from({ length: 6 }).map((_, index) => (
                    <div key={index} className="space-y-3 p-2">
                        <div className="aspect-square animate-pulse rounded-2xl bg-white/[0.06]" />
                        <div className="h-4 w-3/4 animate-pulse rounded bg-white/[0.06]" />
                    </div>
                ))}
            </div>
        );
    }

    if (isError) {
        return (
            <div
                role="alert"
                className="flex flex-col items-center rounded-2xl border border-warning/20 bg-warning/10 px-5 py-8 text-center text-sm text-content-body"
            >
                <p>Could not load your playlists.</p>
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-warning/35 px-4 py-2 font-semibold text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning motion-reduce:transition-none"
                    >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        Retry
                    </button>
                )}
            </div>
        );
    }

    if (playlists.length === 0) {
        return (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 px-6 text-center">
                <ListMusic className="mb-4 h-10 w-10 text-content-muted" />
                <h2 className="text-lg font-semibold text-content">
                    No playlists yet
                </h2>
                <p className="mt-2 max-w-md text-sm text-content-muted">
                    Import a playlist or create one while organizing tracks.
                </p>
                <Link
                    href="/import"
                    className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                >
                    <Upload className="h-4 w-4" aria-hidden="true" />
                    Import playlist
                </Link>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
            {playlists.map((playlist) => (
                <Link
                    key={playlist.id}
                    href={`/playlist/${encodeURIComponent(playlist.id)}`}
                    className="group min-w-0 rounded-[20px] border border-transparent p-2 transition-[transform,background-color,border-color] hover:-translate-y-0.5 hover:border-white/[0.08] hover:bg-white/[0.045] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none"
                >
                    <div className="mb-3 aspect-square overflow-hidden rounded-[18px] bg-surface-highlight shadow-[0_16px_42px_rgb(0_0_0/0.2)] ring-1 ring-white/[0.06]">
                        <PlaylistCover playlist={playlist} />
                    </div>
                    <h3 className="line-clamp-2 min-h-10 text-sm font-bold leading-5 text-content [overflow-wrap:anywhere] sm:text-base">
                        {playlist.name}
                    </h3>
                    <p className="mt-1 truncate text-xs text-content-muted">
                        {playlist.trackCount ?? 0}{" "}
                        {(playlist.trackCount ?? 0) === 1 ? "track" : "tracks"}
                    </p>
                </Link>
            ))}
        </div>
    );
}
