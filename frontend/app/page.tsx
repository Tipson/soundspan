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
        <div className="relative min-h-screen overflow-hidden bg-surface pb-40 pt-3 sm:pb-32 sm:pt-5">
            <div
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-0 h-[34rem] w-[72rem] max-w-[120vw] -translate-x-1/2 rounded-full bg-brand/[0.055] blur-3xl"
            />
            <div className="relative mx-auto max-w-[1600px] px-3 sm:px-6 lg:px-8">
                <div className="space-y-8 sm:space-y-10">
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
                        personalizedFeed={personalizedFeed}
                        isRefreshingMixes={isRefreshingMixes}
                        handleRefreshMixes={handleRefreshMixes}
                    />

                    {personalizedFeed && (
                        <div className="space-y-8 sm:space-y-10">
                            <PersonalizedTrackShelf
                                title="Picked for right now"
                                subtitle="Start anywhere — the full row keeps playing"
                                tracks={personalizedFeed.shelves.quickPicks}
                            />
                            <PersonalizedTrackShelf
                                title="Listen again"
                                subtitle="Music you have recently kept in rotation"
                                tracks={personalizedFeed.shelves.listenAgain}
                            />
                        </div>
                    )}

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
