/**
 * Made For You section for the Explore page.
 *
 * Shows only recommendation playlists that already exist and contain tracks.
 */

import { RefreshCw, Zap } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import {
    HorizontalCarousel,
    CarouselItem,
} from "@/components/ui/HorizontalCarousel";
import { MixCard } from "@/components/MixCard";
import { useFeatures } from "@/lib/features-context";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { StaticPlaylistCard } from "@/features/home/components/StaticPlaylistCard";
import { PersonalizedMixCard } from "@/features/home/components/PersonalizedMixCard";
import type { Mix, PersonalizedHomeFeed } from "@/features/home/types";
import type { DiscoverWeeklySummary } from "@/features/explore/hooks/useExploreData";

interface MadeForYouSectionProps {
    discoverWeekly: DiscoverWeeklySummary | null;
    mixes: Mix[];
    personalizedFeed?: PersonalizedHomeFeed | null;
    isRefreshingMixes: boolean;
    handleRefreshMixes: () => Promise<void>;
}

/**
 * Renders the Made For You section content.
 */
export function MadeForYouSection({
    discoverWeekly,
    mixes,
    personalizedFeed = null,
    isRefreshingMixes,
    handleRefreshMixes,
}: MadeForYouSectionProps) {
    // Mix refresh hits /api/mixes/refresh, which is gated behind the
    // autoPlaylists feature flag — hide the action when the flag is off.
    const { autoPlaylists } = useFeatures();
    const playableDiscoverWeekly =
        discoverWeekly && discoverWeekly.totalCount > 0 ? discoverWeekly : null;
    const playableMixes = mixes.filter((mix) => mix.trackCount > 0);
    const personalizedShelves = personalizedFeed
        ? [
              {
                  key: "quick-picks",
                  title: "Quick picks",
                  description: "A fast route into what fits right now",
                  tracks: personalizedFeed.shelves.quickPicks,
                  tone: "violet" as const,
              },
              {
                  key: "fresh-finds",
                  title: "Fresh finds",
                  description: "New music shaped by your listening",
                  tracks: personalizedFeed.shelves.discovery,
                  tone: "blue" as const,
              },
              {
                  key: "listen-again",
                  title: "Listen again",
                  description: "Recent favorites worth another play",
                  tracks: personalizedFeed.shelves.listenAgain,
                  tone: "amber" as const,
              },
          ].filter((shelf) => shelf.tracks.length > 0)
        : [];
    const hasMadeForYou =
        personalizedShelves.length > 0 ||
        playableDiscoverWeekly !== null ||
        playableMixes.length > 0;

    if (!hasMadeForYou) return null;

    return (
        <section aria-label="Made For You">
            <SectionHeader
                title="Made For You"
                rightAction={
                    autoPlaylists ? (
                        <button
                            onClick={handleRefreshMixes}
                            disabled={isRefreshingMixes}
                            className="group flex min-h-11 items-center gap-2 rounded-full bg-white/5 px-4 py-2 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                        >
                            {isRefreshingMixes ? (
                                <GradientSpinner size="sm" />
                            ) : (
                                <RefreshCw className="w-4 h-4 group-hover:rotate-180 transition-transform duration-500" />
                            )}
                            <span className="hidden sm:inline">
                                {isRefreshingMixes
                                    ? "Refreshing..."
                                    : "Refresh"}
                            </span>
                        </button>
                    ) : undefined
                }
            />
            <p className="-mt-2 mb-4 max-w-2xl text-sm leading-6 text-content-muted">
                Different ways into your music, built only from collections that
                are ready to play.
            </p>
            <HorizontalCarousel aria-label="Made For You">
                {personalizedShelves.map((shelf, index) => (
                    <CarouselItem key={shelf.key}>
                        <PersonalizedMixCard
                            title={shelf.title}
                            description={shelf.description}
                            tracks={shelf.tracks}
                            tone={shelf.tone}
                            index={index}
                        />
                    </CarouselItem>
                ))}
                {playableDiscoverWeekly && (
                    <CarouselItem key="discover-weekly">
                        <StaticPlaylistCard
                            href="/discover"
                            coverUrl={playableDiscoverWeekly.coverUrl}
                            title="Discover Weekly"
                            subtitle={`${playableDiscoverWeekly.totalCount} tracks`}
                            placeholderIcon={
                                <Zap className="h-12 w-12 text-info" />
                            }
                            overlayIcon={
                                <Zap
                                    className="h-6 w-6 text-brand-light"
                                    strokeWidth={2.5}
                                />
                            }
                            index={personalizedShelves.length}
                        />
                    </CarouselItem>
                )}
                {playableMixes.slice(0, 8).map((mix, index) => (
                    <CarouselItem key={mix.id}>
                        <MixCard
                            mix={mix}
                            index={
                                personalizedShelves.length +
                                (playableDiscoverWeekly ? 1 : 0) +
                                index
                            }
                        />
                    </CarouselItem>
                ))}
            </HorizontalCarousel>
        </section>
    );
}
