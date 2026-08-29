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
import type { Mix } from "@/features/home/types";
import type { DiscoverWeeklySummary } from "@/features/explore/hooks/useExploreData";

interface MadeForYouSectionProps {
    discoverWeekly: DiscoverWeeklySummary | null;
    mixes: Mix[];
    isRefreshingMixes: boolean;
    handleRefreshMixes: () => Promise<void>;
}

/**
 * Renders the Made For You section content.
 */
export function MadeForYouSection({
    discoverWeekly,
    mixes,
    isRefreshingMixes,
    handleRefreshMixes,
}: MadeForYouSectionProps) {
    // Mix refresh hits /api/mixes/refresh, which is gated behind the
    // autoPlaylists feature flag — hide the action when the flag is off.
    const { autoPlaylists } = useFeatures();
    const playableDiscoverWeekly =
        discoverWeekly && discoverWeekly.totalCount > 0 ? discoverWeekly : null;
    const playableMixes = mixes.filter((mix) => mix.trackCount > 0);
    const hasMadeForYou =
        playableDiscoverWeekly !== null || playableMixes.length > 0;

    if (!hasMadeForYou) return null;

    return (
        <section>
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
            <HorizontalCarousel>
                {playableDiscoverWeekly && (
                    <CarouselItem key="discover-weekly">
                        <StaticPlaylistCard
                            href="/discover"
                            coverUrl={playableDiscoverWeekly.coverUrl}
                            title="Discover Weekly"
                            subtitle={`${playableDiscoverWeekly.totalCount} tracks`}
                            placeholderIcon={
                                <Zap className="w-12 h-12 text-blue-400" />
                            }
                            overlayIcon={
                                <Zap
                                    className="w-6 h-6 text-pink-500"
                                    strokeWidth={2.5}
                                />
                            }
                            index={0}
                        />
                    </CarouselItem>
                )}
                {playableMixes.map((mix, index) => (
                    <CarouselItem key={mix.id}>
                        <MixCard mix={mix} index={index + 1} />
                    </CarouselItem>
                ))}
            </HorizontalCarousel>
        </section>
    );
}
