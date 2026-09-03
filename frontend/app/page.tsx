"use client";

import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { HomeMadeForYou } from "@/features/home/components/HomeMadeForYou";
import { HomeListeningDashboard } from "@/features/home/components/HomeListeningDashboard";
import { HomeOnlineDiscovery } from "@/features/home/components/HomeOnlineDiscovery";
import { HomeWaveHero } from "@/features/home/components/HomeWaveHero";
import { useHomeData } from "@/features/home/hooks/useHomeData";
import { ru } from "@/lib/i18n/ru";

function PlaylistSkeleton() {
    return (
        <div
            className="relative z-10 grid min-w-0 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]"
            aria-hidden="true"
        >
            <div className="min-w-0">
                <div className="mb-4 h-6 w-48 animate-pulse rounded-lg bg-white/[0.07]" />
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    {[...Array(4)].map((_, index) => (
                        <div key={index} className="min-w-0">
                            <div className="aspect-[1.08/1] animate-pulse rounded-2xl bg-white/[0.055]" />
                            <div className="mt-3 h-4 w-4/5 animate-pulse rounded bg-white/[0.06]" />
                            <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-white/[0.045]" />
                        </div>
                    ))}
                </div>
            </div>
            <div className="hidden xl:block">
                <div className="mb-4 h-6 w-40 animate-pulse rounded-lg bg-white/[0.07]" />
                <div className="space-y-2">
                    {[...Array(4)].map((_, index) => (
                        <div
                            key={index}
                            className="flex items-center gap-3 p-1"
                        >
                            <div className="h-12 w-12 shrink-0 animate-pulse rounded-lg bg-white/[0.055]" />
                            <div className="min-w-0 flex-1">
                                <div className="h-4 w-4/5 animate-pulse rounded bg-white/[0.06]" />
                                <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-white/[0.045]" />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
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
        isLoading,
        isRefreshingMixes,
        isPersonalizedLoading,
        isPersonalizedUnavailable,
        handleRefreshMixes,
    } = useHomeData();

    if (isLoading) return <LoadingScreen />;

    const listeningTracks = personalizedFeed
        ? [
              ...personalizedFeed.shelves.listenAgain,
              ...personalizedFeed.shelves.quickPicks,
              ...personalizedFeed.shelves.discovery,
          ]
        : [];

    return (
        <div
            data-home-layout="personal-dashboard"
            className="relative min-h-full overflow-x-clip bg-transparent"
        >
            <div className="relative mx-auto w-full max-w-[1660px] px-4 pb-10 pt-4 sm:px-7 sm:pt-6 lg:px-10 xl:px-12 2xl:px-14">
                <div className="space-y-8 lg:space-y-10">
                    <div data-home-region="wave">
                        <HomeWaveHero
                            personalizedFeed={personalizedFeed}
                            isLoading={isPersonalizedLoading}
                        />
                    </div>

                    {isPersonalizedLoading && !personalizedFeed && (
                        <section
                            aria-label={ru.home.loadingRecommendations}
                            data-home-region="listening-skeleton"
                        >
                            <PlaylistSkeleton />
                        </section>
                    )}

                    {(isPersonalizedUnavailable ||
                        personalizedFeed?.reason ===
                            "provider_unavailable") && (
                        <p
                            role="status"
                            className="relative z-10 rounded-xl border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning"
                        >
                            {ru.home.unavailable}
                        </p>
                    )}

                    <HomeListeningDashboard
                        tracks={listeningTracks}
                        generationId={personalizedFeed?.generationId}
                    >
                        <div data-home-region="mixes">
                            <HomeMadeForYou
                                discoverWeekly={discoverWeekly}
                                mixes={mixes}
                                personalizedFeed={personalizedFeed}
                                isRefreshingMixes={isRefreshingMixes}
                                handleRefreshMixes={handleRefreshMixes}
                            />
                        </div>
                    </HomeListeningDashboard>

                    <HomeOnlineDiscovery
                        enabled={showYtMusicExplore}
                        homeShelves={homeShelves}
                        chartPlaylists={chartPlaylists}
                    />
                </div>
            </div>
        </div>
    );
}
