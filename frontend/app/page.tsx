"use client";

import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { HomeMadeForYou } from "@/features/home/components/HomeMadeForYou";
import { HomeOnlineDiscovery } from "@/features/home/components/HomeOnlineDiscovery";
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
            data-home-layout="music-canvas"
            className="relative min-h-screen overflow-x-clip bg-transparent pb-40 pt-4 sm:pb-32 sm:pt-6"
        >
            <div className="relative mx-auto w-full max-w-[1720px] px-4 sm:px-7 lg:px-10 2xl:px-12">
                <div className="space-y-8 sm:space-y-10">
                    <header className="max-w-3xl pt-1 sm:pt-2">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-content-muted">
                            Home
                        </p>
                        <h1 className="mt-1 text-[clamp(2rem,4vw,3.5rem)] font-black leading-[0.98] tracking-[-0.045em] text-content">
                            Your music, right now
                        </h1>
                    </header>

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

                    <HomeWaveHero
                        personalizedFeed={personalizedFeed}
                        isLoading={isPersonalizedLoading}
                    />

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
