"use client";

import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useExploreData } from "@/features/explore/hooks/useExploreData";
import { useUserSettingsExplorePrefs } from "@/features/explore/hooks/useUserSettingsExplorePrefs";
import { HomeHero } from "@/features/home/components/HomeHero";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { ArtistsGrid } from "@/features/home/components/ArtistsGrid";
import { LibraryRadioStations } from "@/features/home/components/LibraryRadioStations";
import { PersonalizedTrackShelf } from "@/features/home/components/PersonalizedTrackShelf";
import { usePersonalizedHomeFeed } from "@/features/home/hooks/usePersonalizedHomeFeed";
import { PopularArtistsGrid } from "@/features/home/components/PopularArtistsGrid";
import { MadeForYouSection } from "@/features/explore/components/MadeForYouSection";
import { ExploreDegradedNotice } from "@/features/explore/components/ExploreDegradedNotice";
import { MoodPills } from "@/features/explore/components/MoodPills";
import { ProviderTabSection } from "@/features/explore/components/ProviderTabSection";
import { LastFmBadge } from "@/components/ui/LastFmBadge";
import { LibraryBadge } from "@/components/ui/LibraryBadge";
import { mapYtMusicChartsToFeaturedPlaylists } from "@/hooks/useQueries";
import { useTidalExploreEnabled } from "@/features/explore/hooks/useTidalExploreEnabled";

/**
 * Explore page — the unified discovery landing that consolidates
 * Home, Browse, Radio, and Discovery into a single scrollable experience.
 */
export default function ExplorePage() {
    const { showYtMusicExplore } = useUserSettingsExplorePrefs();
    const { showTidalExplore } = useTidalExploreEnabled();
    const personalizedQuery = usePersonalizedHomeFeed(12);

    const {
        likedSummary,
        discoverWeekly,
        mixes,
        recommended,
        homeShelves,
        charts,
        popularArtists,
        quickStartStations,
        genreStations,
        decadeStations,
        moodCategories,
        genreCategories,
        tidalHomeShelves,
        tidalExploreShelves,
        tidalGenres,
        tidalMoods,
        ytMusicMixes,
        tidalMixes,
        isLoading,
        isRefreshingMixes,
        isMoodsLoading,
        isRadioLoading,
        hasDegradedResults,
        degradedFailureSignature,
        providerFailures,
        handleRefreshMixes,
        retryAll,
    } = useExploreData({ showYtMusicExplore, showTidalExplore });

    if (isLoading) {
        return <LoadingScreen />;
    }

    const chartPlaylists = mapYtMusicChartsToFeaturedPlaylists(charts, 20);
    const personalizedFeed = personalizedQuery.data;
    const hasPersonalQuickStart = Boolean(
        personalizedFeed?.shelves.quickPicks.length,
    );
    const hasPersonalDiscovery = Boolean(
        personalizedFeed?.shelves.discovery.length,
    );
    const hasUsableLocalRadio =
        genreStations.length > 0 || decadeStations.length > 0;

    return (
        <div className="relative">
            <HomeHero />

            <div className="relative max-w-[1800px] mx-auto px-4 sm:px-6 pb-8">
                <div className="space-y-8">
                    {hasPersonalQuickStart && personalizedFeed && (
                        <PersonalizedTrackShelf
                            title="Quick Start"
                            subtitle="Instant radio from your likes and playlists"
                            tracks={personalizedFeed.shelves.quickPicks}
                        />
                    )}

                    {hasPersonalDiscovery && personalizedFeed && (
                        <PersonalizedTrackShelf
                            title="Fresh for you"
                            subtitle="Recommendations shaped by what you actually listen to"
                            tracks={personalizedFeed.shelves.discovery}
                        />
                    )}

                    {!hasPersonalQuickStart &&
                        !personalizedQuery.isLoading &&
                        hasUsableLocalRadio && (
                            <section>
                                <SectionHeader
                                    title="Quick Start"
                                    showAllHref="/radio"
                                    badge={<LibraryBadge />}
                                />
                                <LibraryRadioStations
                                    stations={quickStartStations}
                                    externalLoading={isRadioLoading}
                                />
                            </section>
                        )}

                    <MoodPills />

                    {hasDegradedResults && (
                        <ExploreDegradedNotice
                            key={degradedFailureSignature}
                            onRetry={retryAll}
                        />
                    )}

                    {personalizedQuery.isError && (
                        <p
                            role="status"
                            className="rounded-xl border border-amber-400/20 bg-amber-400/[0.07] px-4 py-3 text-sm text-amber-100/80"
                        >
                            Personal recommendations could not be refreshed. The
                            YouTube Music catalog remains available below.
                        </p>
                    )}

                    {/* Existing saved mixes remain available after immediate-play shelves. */}
                    <MadeForYouSection
                        likedSummary={likedSummary}
                        discoverWeekly={discoverWeekly}
                        mixes={mixes}
                        isRefreshingMixes={isRefreshingMixes}
                        handleRefreshMixes={handleRefreshMixes}
                    />

                    {/* Library Genres Radio */}
                    {(genreStations.length > 0 || isRadioLoading) && (
                        <section>
                            <SectionHeader
                                title="Genres"
                                showAllHref="/radio"
                                badge={<LibraryBadge />}
                            />
                            <LibraryRadioStations
                                stations={genreStations}
                                externalLoading={isRadioLoading}
                            />
                        </section>
                    )}

                    {/* Library Decades Radio */}
                    {(decadeStations.length > 0 || isRadioLoading) && (
                        <section>
                            <SectionHeader
                                title="Decades"
                                showAllHref="/radio"
                                badge={<LibraryBadge />}
                            />
                            <LibraryRadioStations
                                stations={decadeStations}
                                externalLoading={isRadioLoading}
                            />
                        </section>
                    )}

                    {/* Provider Content (YouTube Music | TIDAL tabs) */}
                    <ProviderTabSection
                        showYtMusicExplore={showYtMusicExplore}
                        showTidalExplore={showTidalExplore}
                        ytMusicMixes={ytMusicMixes}
                        moodCategories={moodCategories}
                        genreCategories={genreCategories}
                        isMoodsLoading={isMoodsLoading}
                        homeShelves={homeShelves}
                        chartPlaylists={chartPlaylists}
                        tidalMixes={tidalMixes}
                        tidalMoods={tidalMoods}
                        tidalGenres={tidalGenres}
                        tidalHomeShelves={tidalHomeShelves}
                        tidalExploreShelves={tidalExploreShelves}
                        providerFailures={providerFailures}
                    />

                    {/* Popular Artists */}
                    {popularArtists.length > 0 && (
                        <section>
                            <SectionHeader
                                title="Popular Artists"
                                badge={<LastFmBadge />}
                            />
                            <PopularArtistsGrid artists={popularArtists} />
                        </section>
                    )}

                    {/* Recommended For You */}
                    {recommended.length > 0 && (
                        <section>
                            <SectionHeader
                                title="Recommended For You"
                                showAllHref="/discover"
                                badge="Last.fm"
                            />
                            <ArtistsGrid artists={recommended} />
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
}
