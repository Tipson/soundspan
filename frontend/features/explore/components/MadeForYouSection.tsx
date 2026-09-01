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
import { pluralRu } from "@/lib/i18n/ru";

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
                  title: "Быстрый выбор",
                  description: "Музыка, которая подходит прямо сейчас",
                  tracks: personalizedFeed.shelves.quickPicks,
                  tone: "violet" as const,
              },
              {
                  key: "fresh-finds",
                  title: "Новые находки",
                  description: "Новая музыка с учётом ваших прослушиваний",
                  tracks: personalizedFeed.shelves.discovery,
                  tone: "blue" as const,
              },
              {
                  key: "listen-again",
                  title: "Послушать снова",
                  description:
                      "Недавние любимые треки, к которым стоит вернуться",
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
        <section aria-label="Для вас">
            <SectionHeader
                title="Для вас"
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
                                {isRefreshingMixes ? "Обновляем…" : "Обновить"}
                            </span>
                        </button>
                    ) : undefined
                }
            />
            <p className="-mt-2 mb-4 max-w-2xl text-sm leading-6 text-content-muted">
                Разные способы начать слушать — только готовые подборки, которые
                можно включить сразу.
            </p>
            <HorizontalCarousel aria-label="Для вас">
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
                            title="Открытия недели"
                            subtitle={`${playableDiscoverWeekly.totalCount} ${pluralRu(playableDiscoverWeekly.totalCount, ["трек", "трека", "треков"])}`}
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
