"use client";

import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { HomeMadeForYou } from "@/features/home/components/HomeMadeForYou";
import { HomeOnlineDiscovery } from "@/features/home/components/HomeOnlineDiscovery";
import { HomeQuickActions } from "@/features/home/components/HomeQuickActions";
import { HomeWaveHero } from "@/features/home/components/HomeWaveHero";
import { PersonalizedTrackShelf } from "@/features/home/components/PersonalizedTrackShelf";
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
        mixes,
        discoverWeekly,
        personalizedFeed,
        showYtMusicExplore,
        homeShelves,
        chartPlaylists,
        ytMusicMixes,
        isLoading,
        isRefreshingMixes,
        isPersonalizedLoading,
        isPersonalizedUnavailable,
        handleRefreshMixes,
    } = useHomeData();

    if (isLoading) return <LoadingScreen />;

    return (
        <div
            data-home-layout="editorial"
            className="relative min-h-screen overflow-x-clip bg-transparent pb-40 pt-3 sm:pb-32 sm:pt-5"
        >
            <div
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-0 h-[34rem] w-[72rem] max-w-[120vw] -translate-x-1/2 rounded-full bg-brand/[0.055] blur-3xl"
            />
            <div className="relative mx-auto max-w-[1520px] px-3 sm:px-6 lg:px-8">
                <div className="space-y-7 sm:space-y-9">
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

                    {personalizedFeed && (
                        <PersonalizedTrackShelf
                            title="Continue listening"
                            subtitle="Resume the music still in your rotation"
                            tracks={personalizedFeed.shelves.listenAgain}
                        />
                    )}

                    <HomeMadeForYou
                        discoverWeekly={discoverWeekly}
                        mixes={mixes}
                        personalizedFeed={personalizedFeed}
                        isRefreshingMixes={isRefreshingMixes}
                        handleRefreshMixes={handleRefreshMixes}
                    />

                    <HomeOnlineDiscovery
                        enabled={showYtMusicExplore}
                        ytMusicMixes={ytMusicMixes}
                        homeShelves={homeShelves}
                        chartPlaylists={chartPlaylists}
                    />
                </div>
            </div>
        </div>
    );
}
