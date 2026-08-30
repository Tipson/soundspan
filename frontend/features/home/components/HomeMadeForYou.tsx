"use client";

import Link from "next/link";
import { useMemo } from "react";
import { RefreshCw, Zap } from "lucide-react";
import { CoverMosaic } from "@/components/ui/CoverMosaic";
import { api } from "@/lib/api";
import { useFeatures } from "@/lib/features-context";
import type { DiscoverWeeklySummary } from "@/features/explore/hooks/useExploreData";
import type { Mix, PersonalizedHomeFeed, PersonalizedTrack } from "../types";
import { PersonalizedMixCard } from "./PersonalizedMixCard";
import { SectionHeader } from "./SectionHeader";
import { StaticPlaylistCard } from "./StaticPlaylistCard";

const MAX_PERSONAL_MIX_TRACKS = 12;
const MAX_HOME_MADE_CARDS = 6;

interface HomePersonalMix {
    key: string;
    title: string;
    description: string;
    tracks: PersonalizedTrack[];
    tone: "violet" | "blue" | "amber";
}

interface HomeMadeForYouProps {
    discoverWeekly: DiscoverWeeklySummary | null;
    mixes: Mix[];
    personalizedFeed: PersonalizedHomeFeed | null;
    isRefreshingMixes: boolean;
    handleRefreshMixes: () => Promise<void>;
}

function uniqueTracks(tracks: PersonalizedTrack[]): PersonalizedTrack[] {
    const seen = new Set<string>();
    return tracks.filter((track) => {
        const key = track.youtubeVideoId || track.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function roundRobinTracks(
    sources: PersonalizedTrack[][],
    limit: number,
): PersonalizedTrack[] {
    const positions = sources.map(() => 0);
    const result: PersonalizedTrack[] = [];
    const seen = new Set<string>();

    while (result.length < limit) {
        let added = false;
        sources.forEach((source, sourceIndex) => {
            while (
                positions[sourceIndex] < source.length &&
                result.length < limit
            ) {
                const track = source[positions[sourceIndex]];
                positions[sourceIndex] += 1;
                const key = track.youtubeVideoId || track.id;
                if (seen.has(key)) continue;
                seen.add(key);
                result.push(track);
                added = true;
                break;
            }
        });
        if (!added) break;
    }

    return result;
}

/** Builds different playable mixes from independent account signals. */
export function buildHomePersonalMixes(
    feed: PersonalizedHomeFeed | null,
): HomePersonalMix[] {
    if (!feed) return [];

    const quickPicks = uniqueTracks(feed.shelves.quickPicks);
    const discovery = uniqueTracks(feed.shelves.discovery);
    const listenAgain = uniqueTracks(feed.shelves.listenAgain);
    const recipes: Array<
        Omit<HomePersonalMix, "tracks"> & {
            candidates: PersonalizedTrack[];
        }
    > = [
        {
            key: "daily-blend",
            title: "Daily blend",
            description: "A balanced mix for right now",
            candidates: roundRobinTracks(
                [quickPicks, discovery, listenAgain],
                quickPicks.length + discovery.length + listenAgain.length,
            ),
            tone: "violet",
        },
        {
            key: "fresh-finds",
            title: "Fresh finds",
            description: "New music around what you already enjoy",
            candidates: discovery,
            tone: "blue",
        },
        {
            key: "back-in-rotation",
            title: "Back in rotation",
            description: "Recent favorites worth another play",
            candidates: listenAgain,
            tone: "amber",
        },
        {
            key: "quick-picks",
            title: "Quick picks",
            description: "An immediate route into your taste",
            candidates: quickPicks,
            tone: "violet",
        },
    ];

    const uniqueAvailableTracks = uniqueTracks([
        ...quickPicks,
        ...discovery,
        ...listenAgain,
    ]);
    if (uniqueAvailableTracks.length === 0) return [];

    // Every visible collection must earn its place with at least roughly two
    // unique tracks. When the account has fewer signals, showing fewer useful
    // cards is more honest than repeating the same artwork and songs.
    const visibleRecipeCount = Math.max(
        1,
        Math.min(recipes.length, Math.floor(uniqueAvailableTracks.length / 2)),
    );
    const visibleRecipes = recipes.slice(0, visibleRecipeCount);
    const positions = visibleRecipes.map(() => 0);
    const assigned = new Set<string>();
    const allocated: HomePersonalMix[] = visibleRecipes.map((recipe) => ({
        key: recipe.key,
        title: recipe.title,
        description: recipe.description,
        tone: recipe.tone,
        tracks: [],
    }));

    let assignedInRound = true;
    while (assignedInRound) {
        assignedInRound = false;
        visibleRecipes.forEach((recipe, recipeIndex) => {
            const target = allocated[recipeIndex];
            if (target.tracks.length >= MAX_PERSONAL_MIX_TRACKS) return;

            while (positions[recipeIndex] < recipe.candidates.length) {
                const candidate = recipe.candidates[positions[recipeIndex]];
                positions[recipeIndex] += 1;
                const identity = candidate.youtubeVideoId || candidate.id;
                if (assigned.has(identity)) continue;
                assigned.add(identity);
                target.tracks.push(candidate);
                assignedInRound = true;
                break;
            }
        });
    }

    return allocated.filter((recipe) => recipe.tracks.length > 0);
}

function GeneratedMixCard({ mix }: { mix: Mix }) {
    const covers = useMemo(
        () =>
            mix.coverUrls
                .slice(0, 4)
                .map((url) => api.getCoverArtUrl(url, 320)),
        [mix.coverUrls],
    );

    return (
        <Link
            href={`/mix/${mix.id}`}
            className="group block min-w-0 rounded-[1.125rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        >
            <span className="relative mb-3 block aspect-square overflow-hidden rounded-[1.125rem] bg-surface-highlight shadow-lg shadow-black/25">
                <CoverMosaic
                    coverUrls={covers}
                    hoverScale
                    imageSizes="(max-width: 640px) 70vw, 190px"
                    showEmptyCellIcon
                />
                <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-transparent" />
            </span>
            <span className="block truncate text-sm font-bold text-content sm:text-[0.9375rem]">
                {mix.name}
            </span>
            <span className="mt-1 line-clamp-2 block text-xs leading-5 text-content-muted">
                {mix.description}
            </span>
        </Link>
    );
}

/** A bounded, account-specific row of playable personal collections. */
export function HomeMadeForYou({
    discoverWeekly,
    mixes,
    personalizedFeed,
    isRefreshingMixes,
    handleRefreshMixes,
}: HomeMadeForYouProps) {
    const { autoPlaylists } = useFeatures();
    const personalMixes = buildHomePersonalMixes(personalizedFeed);
    const playableDiscoverWeekly =
        discoverWeekly && discoverWeekly.totalCount > 0 ? discoverWeekly : null;
    const playableMixes = mixes.filter((mix) => mix.trackCount > 0);
    const availableCount =
        personalMixes.length +
        (playableDiscoverWeekly ? 1 : 0) +
        playableMixes.length;

    if (availableCount === 0) return null;

    const visiblePersonalMixes = personalMixes.slice(0, MAX_HOME_MADE_CARDS);
    const showDiscoverWeekly =
        Boolean(playableDiscoverWeekly) &&
        visiblePersonalMixes.length < MAX_HOME_MADE_CARDS;
    const visibleGeneratedMixes = playableMixes.slice(
        0,
        MAX_HOME_MADE_CARDS -
            visiblePersonalMixes.length -
            (showDiscoverWeekly ? 1 : 0),
    );

    return (
        <section aria-label="Made for you">
            <SectionHeader
                title="Made for you"
                rightAction={
                    autoPlaylists ? (
                        <button
                            type="button"
                            onClick={() => void handleRefreshMixes()}
                            disabled={isRefreshingMixes}
                            aria-label={
                                isRefreshingMixes
                                    ? "Refreshing personal mixes"
                                    : "Refresh personal mixes"
                            }
                            className="grid min-h-11 min-w-11 place-items-center rounded-full text-content-muted transition duration-200 hover:bg-white/[0.07] hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:opacity-45 motion-reduce:transition-none"
                        >
                            <RefreshCw
                                className={`h-4 w-4 ${isRefreshingMixes ? "animate-spin motion-reduce:animate-none" : ""}`}
                                aria-hidden="true"
                            />
                        </button>
                    ) : undefined
                }
            />
            <p className="-mt-2 mb-4 max-w-2xl text-sm leading-6 text-content-muted">
                Different mixes from your listening, not copies of the same
                shelf.
            </p>
            <div className="scrollbar-hide grid touch-pan-x snap-x snap-proximity grid-flow-col auto-cols-[72vw] gap-3 overflow-x-auto overscroll-x-contain pb-1 sm:auto-cols-[11rem] sm:gap-4 lg:grid-flow-row lg:grid-cols-4 lg:overflow-visible xl:grid-cols-6">
                {visiblePersonalMixes.map((mix, index) => (
                    <div
                        key={mix.key}
                        data-home-made-card={mix.key}
                        className="min-w-0 snap-start"
                    >
                        <PersonalizedMixCard
                            title={mix.title}
                            description={mix.description}
                            tracks={mix.tracks}
                            tone={mix.tone}
                            index={index}
                        />
                    </div>
                ))}

                {showDiscoverWeekly && playableDiscoverWeekly && (
                    <div
                        data-home-made-card="discover-weekly"
                        className="min-w-0 snap-start"
                    >
                        <StaticPlaylistCard
                            href="/discover"
                            coverUrl={playableDiscoverWeekly.coverUrl}
                            title="Discover Weekly"
                            subtitle={`${playableDiscoverWeekly.totalCount} tracks · refreshed for you`}
                            placeholderIcon={
                                <Zap
                                    className="h-11 w-11 text-brand-light"
                                    aria-hidden="true"
                                />
                            }
                        />
                    </div>
                )}

                {visibleGeneratedMixes.map((mix) => (
                    <div
                        key={mix.id}
                        data-home-made-card={mix.id}
                        className="min-w-0 snap-start"
                    >
                        <GeneratedMixCard mix={mix} />
                    </div>
                ))}
            </div>
        </section>
    );
}
