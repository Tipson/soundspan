"use client";

import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { LastFmBadge } from "@/components/ui/LastFmBadge";
import { MadeForYouSection } from "@/features/explore/components/MadeForYouSection";
import { ArtistsGrid } from "@/features/home/components/ArtistsGrid";
import { HomeOnlineDiscovery } from "@/features/home/components/HomeOnlineDiscovery";
import { HomeQuickActions } from "@/features/home/components/HomeQuickActions";
import { HomeWaveHero } from "@/features/home/components/HomeWaveHero";
import { PersonalizedTrackShelf } from "@/features/home/components/PersonalizedTrackShelf";
import { PopularArtistsGrid } from "@/features/home/components/PopularArtistsGrid";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { useHomeData } from "@/features/home/hooks/useHomeData";

function PlaylistSkeleton() {
    return (
        <div className="flex gap-3 overflow-hidden" aria-hidden="true">
            {[...Array(6)].map((_, index) => (
                <div
                    key={index}
                    className="w-[140px] shrink-0 p-3 sm:w-[160px] md:w-[170px]"
                >
                    <div className="mb-3 aspect-square animate-pulse rounded-lg bg-white/5" />
                    <div className="mb-2 h-4 w-3/4 animate-pulse rounded bg-white/5" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-white/5" />
                </div>
            ))}
        </div>
    );
}

/** Unified online-first music landing: immediate Wave, personal feed, catalog. */
export default function HomePage() {
    const {
        recommended,
        mixes,
        discoverWeekly,
        popularArtists,
        personalizedFeed,
        showYtMusicExplore,
        homeShelves,
        chartPlaylists,
        moodCategories,
        genreCategories,
        ytMusicMixes,
        isLoading,
        isRefreshingMixes,
        isPersonalizedLoading,
        isPersonalizedUnavailable,
        isMoodsLoading,
        handleRefreshMixes,
    } = useHomeData();

    if (isLoading) return <LoadingScreen />;

    return (
        <div className="relative min-h-screen bg-surface pb-28 pt-4 sm:pt-6">
            <div className="relative mx-auto max-w-[1800px] px-4 sm:px-6">
                <div className="space-y-6 sm:space-y-8">
                    <HomeWaveHero
                        personalizedFeed={personalizedFeed}
                        isLoading={isPersonalizedLoading}
                    />

                    <HomeQuickActions />

                    {isPersonalizedLoading && !personalizedFeed && (
                        <section
                            aria-label="Loading personal recommendations"
                            className="rounded-2xl border border-white/8 bg-white/[0.035] p-5"
                        >
                            <div className="mb-4 h-7 w-40 animate-pulse rounded bg-white/10" />
                            <PlaylistSkeleton />
                        </section>
                    )}

                    {personalizedFeed && (
                        <>
                            <PersonalizedTrackShelf
                                title="Quick picks"
                                subtitle="Ready to play from your likes and playlists"
                                tracks={personalizedFeed.shelves.quickPicks}
                            />
                            <PersonalizedTrackShelf
                                title="Listen again"
                                subtitle="Music you recently played"
                                tracks={personalizedFeed.shelves.listenAgain}
                            />
                            <PersonalizedTrackShelf
                                title="Fresh for you"
                                subtitle="New tracks from your personal radio"
                                tracks={personalizedFeed.shelves.discovery}
                            />
                        </>
                    )}

                    {(isPersonalizedUnavailable ||
                        personalizedFeed?.reason ===
                            "provider_unavailable") && (
                        <p
                            role="status"
                            className="rounded-xl border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning"
                        >
                            Personal radio is temporarily unavailable. Search,
                            playlists, and the online catalog still work.
                        </p>
                    )}

                    <MadeForYouSection
                        discoverWeekly={discoverWeekly}
                        mixes={mixes}
                        isRefreshingMixes={isRefreshingMixes}
                        handleRefreshMixes={handleRefreshMixes}
                    />

                    <HomeOnlineDiscovery
                        enabled={showYtMusicExplore}
                        ytMusicMixes={ytMusicMixes}
                        moodCategories={moodCategories}
                        genreCategories={genreCategories}
                        isMoodsLoading={isMoodsLoading}
                        homeShelves={homeShelves}
                        chartPlaylists={chartPlaylists}
                    />

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

                    {popularArtists.length > 0 && (
                        <section>
                            <SectionHeader
                                title="Popular Artists"
                                badge={<LastFmBadge />}
                            />
                            <PopularArtistsGrid artists={popularArtists} />
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
}
