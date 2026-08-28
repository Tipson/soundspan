"use client";

import Link from "next/link";
import { AudioWaveform, Loader2, Map } from "lucide-react";
import { PersonalizedTrackShelf } from "@/features/home/components/PersonalizedTrackShelf";
import { usePersonalizedHomeFeed } from "@/features/home/hooks/usePersonalizedHomeFeed";
import type { PersonalizedTrack } from "@/features/home/types";

interface VibeAvailabilityProps {
    embeddedTracks: number | null;
}

interface VibeViewTabsProps {
    onExplore: () => void;
    onMap: () => void;
}

function selectProviderRadioTracks(
    shelves:
        | {
              quickPicks: PersonalizedTrack[];
              discovery: PersonalizedTrack[];
              listenAgain: PersonalizedTrack[];
          }
        | undefined,
): PersonalizedTrack[] {
    if (!shelves) return [];
    if (shelves.quickPicks.length > 0) return shelves.quickPicks;
    if (shelves.discovery.length > 0) return shelves.discovery;
    return shelves.listenAgain;
}

/** Replaces unusable Audio-DNA controls with immediately playable provider radio. */
export function VibeProviderFallback({
    embeddedTracks,
}: VibeAvailabilityProps) {
    const { data, isLoading, isError } = usePersonalizedHomeFeed(12, true);
    const tracks = selectProviderRadioTracks(data?.shelves);

    return (
        <main className="min-h-screen px-6 py-6">
            <div className="mx-auto max-w-5xl space-y-6">
                <section className="overflow-hidden rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 via-surface-raised to-ai/10 p-6 sm:p-8">
                    <div className="flex items-start gap-4">
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
                            <AudioWaveform
                                className="h-6 w-6"
                                aria-hidden="true"
                            />
                        </span>
                        <div>
                            <p className="text-sm font-medium text-brand">
                                Vibe
                            </p>
                            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">
                                Radio while Vibe warms up
                            </h1>
                            <p className="mt-3 max-w-2xl text-sm leading-6 text-content-muted">
                                {embeddedTracks === null
                                    ? "Audio-DNA status is temporarily unavailable. Provider radio remains ready with playable recommendations."
                                    : `Audio-DNA Vibe needs at least two locally stored, analyzed files. You currently have ${embeddedTracks}. Until then, provider radio can still give you playable recommendations.`}
                            </p>
                        </div>
                    </div>
                </section>

                {isLoading ? (
                    <div
                        className="flex items-center justify-center py-16"
                        aria-label="Loading provider radio"
                    >
                        <Loader2 className="h-6 w-6 animate-spin text-content-disabled" />
                    </div>
                ) : tracks.length > 0 ? (
                    <PersonalizedTrackShelf
                        title="Provider radio"
                        subtitle="Playable recommendations while Audio DNA builds"
                        tracks={tracks}
                    />
                ) : (
                    <section className="rounded-2xl border border-surface-active bg-surface-raised p-6">
                        <h2 className="text-lg font-semibold text-white">
                            Provider radio is unavailable
                        </h2>
                        <p className="mt-2 text-sm text-content-muted">
                            {isError
                                ? "Recommendations could not be loaded right now."
                                : "Play or like a few tracks to build your personal radio."}
                        </p>
                    </section>
                )}

                <nav
                    className="flex flex-wrap gap-3"
                    aria-label="Music shortcuts"
                >
                    <Link
                        href="/"
                        className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-black transition hover:brightness-110"
                    >
                        Open Home
                    </Link>
                    <Link
                        href="/search"
                        className="rounded-full border border-surface-active bg-surface-raised px-5 py-2.5 text-sm font-semibold text-white transition hover:border-line-strong"
                    >
                        Search music
                    </Link>
                </nav>
            </div>
        </main>
    );
}

/** Explains why small Audio-DNA libraries can compare tracks but not map them. */
export function VibeLimitedNotice({ embeddedTracks }: VibeAvailabilityProps) {
    return (
        <aside className="mb-6 rounded-xl border border-ai/20 bg-ai/5 px-4 py-3">
            <p className="text-sm font-medium text-white">Limited Audio DNA</p>
            <p className="mt-1 text-sm text-content-muted">
                Comparisons use your {embeddedTracks} analyzed local files. The
                full Vibe map needs at least 5 locally analyzed files.
            </p>
        </aside>
    );
}

/** Shows the full-map switch only after the Audio-DNA corpus is useful. */
export function VibeViewTabs({ onExplore, onMap }: VibeViewTabsProps) {
    return (
        <div className="mt-4 flex max-w-xs gap-1 rounded-lg bg-white/5 p-1">
            <button
                type="button"
                onClick={onExplore}
                aria-current="page"
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-white/10 py-1.5 text-sm font-medium text-white"
            >
                <AudioWaveform className="h-4 w-4" aria-hidden="true" />
                Explore
            </button>
            <button
                type="button"
                onClick={onMap}
                className="flex flex-1 items-center justify-center gap-2 rounded-md py-1.5 text-sm font-medium text-gray-400 transition-colors hover:text-gray-300"
            >
                <Map className="h-4 w-4" aria-hidden="true" />
                Map
            </button>
        </div>
    );
}
