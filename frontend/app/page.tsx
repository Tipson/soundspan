"use client";

import { Heart, Zap, RefreshCw } from "lucide-react";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import {
    HorizontalCarousel,
    CarouselItem,
} from "@/components/ui/HorizontalCarousel";
import { MixCard } from "@/components/MixCard";
import { HomeWaveHero } from "@/features/home/components/HomeWaveHero";
import { HomeQuickActions } from "@/features/home/components/HomeQuickActions";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { ArtistsGrid } from "@/features/home/components/ArtistsGrid";
import { PopularArtistsGrid } from "@/features/home/components/PopularArtistsGrid";
import { FeaturedPlaylistsGrid } from "@/features/home/components/FeaturedPlaylistsGrid";
import { StaticPlaylistCard } from "@/features/home/components/StaticPlaylistCard";
import { PersonalizedTrackShelf } from "@/features/home/components/PersonalizedTrackShelf";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { LastFmBadge } from "@/components/ui/LastFmBadge";
import { useFeatures } from "@/lib/features-context";
import { useHomeData } from "@/features/home/hooks/useHomeData";

// Loading skeleton for playlist cards
function PlaylistSkeleton() {
    return (
        <div className="flex gap-3 overflow-hidden">
            {[...Array(8)].map((_, i) => (
                <div
                    key={i}
                    className="flex-shrink-0 w-[140px] sm:w-[160px] md:w-[170px] lg:w-[180px] p-3"
                >
                    <div className="aspect-square rounded-md bg-white/5 animate-pulse mb-3" />
                    <div className="h-4 bg-white/5 rounded animate-pulse w-3/4 mb-2" />
                    <div className="h-3 bg-white/5 rounded animate-pulse w-1/2" />
                </div>
            ))}
        </div>
    );
}

/**
 * Home page — personal-radio landing with immediate playback, quick access,
 * personalized shelves, and broader discovery recommendations.
 */
export default function HomePage() {
    const {
        recommended,
        mixes,
        likedSummary,
        discoverWeekly,
        popularArtists,
        communityPlaylists,
        personalizedFeed,
        isLoading,
        isRefreshingMixes,
        isCommunityPlaylistsLoading,
        isPersonalizedLoading,
        isPersonalizedUnavailable,
        handleRefreshMixes,
    } = useHomeData();
    const { autoPlaylists } = useFeatures();

    if (isLoading) {
        return <LoadingScreen />;
    }

    const hasMadeForYou =
        likedSummary !== null || discoverWeekly !== null || mixes.length > 0;

    return (
        <div className="relative min-h-screen bg-surface pb-28 pt-4 sm:pt-6">
            <div className="relative mx-auto max-w-[1800px] px-4 sm:px-6">
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
                            Personal radio is temporarily unavailable. Your
                            liked tracks, playlists, and search still work
                            normally.
                        </p>
                    )}

                    {/* Made For You */}
                    {hasMadeForYou && (
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
                                {likedSummary && (
                                    <CarouselItem key="my-liked">
                                        <StaticPlaylistCard
                                            href="/playlist/my-liked"
                                            coverUrl={likedSummary.coverUrl}
                                            title="My Liked"
                                            subtitle={`${likedSummary.total} tracks`}
                                            placeholderIcon={
                                                <Heart className="h-12 w-12 fill-brand/25 text-brand-light" />
                                            }
                                            overlayIcon={
                                                <Heart
                                                    className="h-6 w-6 text-brand-light"
                                                    strokeWidth={2.5}
                                                />
                                            }
                                            index={0}
                                        />
                                    </CarouselItem>
                                )}
                                {discoverWeekly && (
                                    <CarouselItem key="discover-weekly">
                                        <StaticPlaylistCard
                                            href="/discover"
                                            coverUrl={discoverWeekly.coverUrl}
                                            title="Discover Weekly"
                                            subtitle={`${discoverWeekly.totalCount} tracks`}
                                            placeholderIcon={
                                                <Zap className="h-12 w-12 text-ai-hover" />
                                            }
                                            overlayIcon={
                                                <Zap
                                                    className="h-6 w-6 text-ai-hover"
                                                    strokeWidth={2.5}
                                                />
                                            }
                                            index={1}
                                        />
                                    </CarouselItem>
                                )}
                                {mixes.map((mix, index) => (
                                    <CarouselItem key={mix.id}>
                                        <MixCard mix={mix} index={index + 2} />
                                    </CarouselItem>
                                ))}
                            </HorizontalCarousel>
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

                    {/* Trending Community Playlists */}
                    {(isCommunityPlaylistsLoading ||
                        communityPlaylists.length > 0) && (
                        <section>
                            <SectionHeader
                                title="Trending Community Playlists"
                                badge={<YouTubeBadge />}
                            />
                            {isCommunityPlaylistsLoading &&
                            communityPlaylists.length === 0 ? (
                                <PlaylistSkeleton />
                            ) : (
                                <FeaturedPlaylistsGrid
                                    playlists={communityPlaylists}
                                />
                            )}
                        </section>
                    )}

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
                </div>
            </div>
        </div>
    );
}
