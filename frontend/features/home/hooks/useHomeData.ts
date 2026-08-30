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
import type { Mix, PersonalizedHomeFeed } from "../types";
import { usePersonalizedHomeFeed } from "./usePersonalizedHomeFeed";
import {
    mapYtMusicChartsToFeaturedPlaylists,
    queryKeys,
    useDiscoverWeeklySummaryQuery,
    useMixesQuery,
    useRefreshMixesMutation,
    useYtMusicChartsQuery,
    useYtMusicHomeShelvesQuery,
    type PlaylistPreview,
    type YtMusicHomeShelf,
} from "@/hooks/useQueries";

export interface UseHomeDataReturn {
    mixes: Mix[];
    discoverWeekly: DiscoverWeeklySummary | null;
    personalizedFeed: PersonalizedHomeFeed | null;
    showYtMusicExplore: boolean;
    homeShelves: YtMusicHomeShelf[];
    chartPlaylists: PlaylistPreview[];
    isLoading: boolean;
    isRefreshingMixes: boolean;
    isPersonalizedLoading: boolean;
    isPersonalizedUnavailable: boolean;
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

    const mixesQuery = useMixesQuery(autoPlaylists);
    const discoverQuery = useDiscoverWeeklySummaryQuery(discovery);

    const shelvesQuery = useYtMusicHomeShelvesQuery({
        enabled: showYtMusicExplore,
    });
    const chartsQuery = useYtMusicChartsQuery({
        enabled: showYtMusicExplore,
    });
    const { mutateAsync: refreshMixes, isPending: isRefreshingMixes } =
        useRefreshMixesMutation();

    const handleRefreshMixes = async () => {
        try {
            await refreshMixes();
            toast.success("Миксы обновлены — новые подборки уже готовы");
        } catch (error) {
            log.error("Failed to refresh mixes:", error);
            toast.error("Не удалось обновить миксы");
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
    const hasPrimaryData =
        personalizedTrackCount > 0 ||
        mixes.length > 0 ||
        discoverWeekly !== null;
    const allPrimaryLoading =
        personalizedQuery.isLoading && mixesQuery.isLoading;

    return {
        mixes,
        discoverWeekly,
        personalizedFeed: personalizedQuery.data ?? null,
        showYtMusicExplore,
        homeShelves: shelvesQuery.data ?? [],
        chartPlaylists: mapYtMusicChartsToFeaturedPlaylists(
            chartsQuery.data,
            12,
        ),
        isLoading: !isAuthenticated || (!hasPrimaryData && allPrimaryLoading),
        isRefreshingMixes,
        isPersonalizedLoading: personalizedQuery.isLoading,
        isPersonalizedUnavailable: personalizedQuery.isError,
        handleRefreshMixes,
    };
}
