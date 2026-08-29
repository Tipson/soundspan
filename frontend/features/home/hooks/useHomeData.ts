/** Home feed data: account signals plus live online-catalog discovery. */

import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useFeatures } from "@/lib/features-context";
import { frontendLogger as log } from "@/lib/logger";
import { useUserSettingsExplorePrefs } from "@/features/explore/hooks/useUserSettingsExplorePrefs";
import type { DiscoverWeeklySummary } from "@/features/explore/hooks/useExploreData";
import type {
    Artist,
    Mix,
    PersonalizedHomeFeed,
    PopularArtist,
} from "../types";
import { usePersonalizedHomeFeed } from "./usePersonalizedHomeFeed";
import {
    mapYtMusicChartsToFeaturedPlaylists,
    queryKeys,
    useDiscoverWeeklySummaryQuery,
    useMixesQuery,
    usePopularArtistsQuery,
    useRecommendationsQuery,
    useRefreshMixesMutation,
    useYtMusicCategoriesQuery,
    useYtMusicChartsQuery,
    useYtMusicHomeShelvesQuery,
    useYtMusicMixesQuery,
    type PlaylistPreview,
    type YtMusicCategory,
    type YtMusicHomeShelf,
    type YtMusicMixPreview,
} from "@/hooks/useQueries";

export interface UseHomeDataReturn {
    recommended: Artist[];
    mixes: Mix[];
    discoverWeekly: DiscoverWeeklySummary | null;
    popularArtists: PopularArtist[];
    personalizedFeed: PersonalizedHomeFeed | null;
    showYtMusicExplore: boolean;
    homeShelves: YtMusicHomeShelf[];
    chartPlaylists: PlaylistPreview[];
    moodCategories: YtMusicCategory[];
    genreCategories: YtMusicCategory[];
    ytMusicMixes: YtMusicMixPreview[];
    isLoading: boolean;
    isRefreshingMixes: boolean;
    isPersonalizedLoading: boolean;
    isPersonalizedUnavailable: boolean;
    isMoodsLoading: boolean;
    handleRefreshMixes: () => Promise<void>;
}

/** Loads one coherent Home feed without legacy local-media browse queries. */
export function useHomeData(): UseHomeDataReturn {
    const { isAuthenticated } = useAuth();
    const { discovery, autoPlaylists } = useFeatures();
    const { showYtMusicExplore } = useUserSettingsExplorePrefs();
    const queryClient = useQueryClient();
    const personalizedQuery = usePersonalizedHomeFeed(12, isAuthenticated);

    useEffect(() => {
        const handleMixesUpdated = () => {
            queryClient.refetchQueries({ queryKey: queryKeys.mixes() });
        };
        window.addEventListener("mixes-updated", handleMixesUpdated);
        return () =>
            window.removeEventListener("mixes-updated", handleMixesUpdated);
    }, [queryClient]);

    const recommendedQuery = useRecommendationsQuery(10, discovery);
    const mixesQuery = useMixesQuery(autoPlaylists);
    const discoverQuery = useDiscoverWeeklySummaryQuery(discovery);
    const popularQuery = usePopularArtistsQuery(20, { enabled: discovery });

    const shelvesQuery = useYtMusicHomeShelvesQuery({
        enabled: showYtMusicExplore,
    });
    const chartsQuery = useYtMusicChartsQuery({
        enabled: showYtMusicExplore,
    });
    const categoriesQuery = useYtMusicCategoriesQuery({
        enabled: showYtMusicExplore,
    });
    const ytMusicMixesQuery = useYtMusicMixesQuery({
        enabled: showYtMusicExplore,
    });

    const { mutateAsync: refreshMixes, isPending: isRefreshingMixes } =
        useRefreshMixesMutation();

    const handleRefreshMixes = async () => {
        try {
            await refreshMixes();
            toast.success("Mixes refreshed! Check out your new daily picks");
        } catch (error) {
            log.error("Failed to refresh mixes:", error);
            toast.error("Failed to refresh mixes");
        }
    };

    const discoverWeekly = useMemo<DiscoverWeeklySummary | null>(() => {
        const discoverData = discoverQuery.data;
        if (!discovery || !discoverData) return null;
        const firstCover = discoverData.tracks?.[0]?.coverUrl ?? null;
        return {
            weekStart: discoverData.weekStart,
            weekEnd: discoverData.weekEnd,
            totalCount: discoverData.totalCount,
            coverUrl: firstCover ? api.getCoverArtUrl(firstCover, 200) : null,
        };
    }, [discovery, discoverQuery.data]);

    const personalizedTrackCount = personalizedQuery.data
        ? personalizedQuery.data.shelves.listenAgain.length +
          personalizedQuery.data.shelves.quickPicks.length +
          personalizedQuery.data.shelves.discovery.length
        : 0;
    const mixes =
        autoPlaylists && Array.isArray(mixesQuery.data) ? mixesQuery.data : [];
    const recommended = discovery ? (recommendedQuery.data?.artists ?? []) : [];
    const popularArtists = discovery ? (popularQuery.data?.artists ?? []) : [];
    const hasPrimaryData =
        personalizedTrackCount > 0 ||
        recommended.length > 0 ||
        mixes.length > 0 ||
        popularArtists.length > 0;
    const allPrimaryLoading =
        personalizedQuery.isLoading &&
        recommendedQuery.isLoading &&
        mixesQuery.isLoading &&
        popularQuery.isLoading;

    return {
        recommended,
        mixes,
        discoverWeekly,
        popularArtists,
        personalizedFeed: personalizedQuery.data ?? null,
        showYtMusicExplore,
        homeShelves: shelvesQuery.data ?? [],
        chartPlaylists: mapYtMusicChartsToFeaturedPlaylists(
            chartsQuery.data,
            12,
        ),
        moodCategories: categoriesQuery.data?.moodCategories ?? [],
        genreCategories: categoriesQuery.data?.genreCategories ?? [],
        ytMusicMixes: ytMusicMixesQuery.data ?? [],
        isLoading: !isAuthenticated || (!hasPrimaryData && allPrimaryLoading),
        isRefreshingMixes,
        isPersonalizedLoading: personalizedQuery.isLoading,
        isPersonalizedUnavailable: personalizedQuery.isError,
        isMoodsLoading: categoriesQuery.isLoading,
        handleRefreshMixes,
    };
}
