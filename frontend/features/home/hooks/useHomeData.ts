/** Home feed data: personal listening signals and mixes. */

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useFeatures } from "@/lib/features-context";
import { frontendLogger as log } from "@/lib/logger";
import { useAudioState } from "@/lib/audio-state-context";
import type { DiscoverWeeklySummary } from "@/features/explore/hooks/useExploreData";
import type { Mix, PersonalizedHomeFeed } from "../types";
import { timeOfDayMixForHour, type TimeOfDayMix } from "../timeOfDayMix";
import { usePersonalizedHomeFeed } from "./usePersonalizedHomeFeed";
import {
    queryKeys,
    useDiscoverWeeklySummaryQuery,
    useMixesQuery,
    useRefreshMixesMutation,
} from "@/hooks/useQueries";

export interface UseHomeDataReturn {
    mixes: Mix[];
    discoverWeekly: DiscoverWeeklySummary | null;
    personalizedFeed: PersonalizedHomeFeed | null;
    dailyMixFeed: PersonalizedHomeFeed | null;
    timeOfDayFeed: PersonalizedHomeFeed | null;
    timeOfDayMix: TimeOfDayMix | null;
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
    const { waveMode, waveMood } = useAudioState();
    const queryClient = useQueryClient();
    const [localHour, setLocalHour] = useState<number | null>(null);
    useEffect(() => {
        const updateHour = () => setLocalHour(new Date().getHours());
        updateHour();
        const interval = window.setInterval(updateHour, 60_000);
        window.addEventListener("focus", updateHour);
        document.addEventListener("visibilitychange", updateHour);
        return () => {
            window.clearInterval(interval);
            window.removeEventListener("focus", updateHour);
            document.removeEventListener("visibilitychange", updateHour);
        };
    }, []);
    const timeOfDayMix =
        localHour === null ? null : timeOfDayMixForHour(localHour);
    const personalizedQuery = usePersonalizedHomeFeed(
        12,
        isAuthenticated,
        waveMode,
        waveMood,
    );
    const dailyMixQuery = usePersonalizedHomeFeed(
        25,
        isAuthenticated,
        "for-you",
        null,
        "made-for-you",
    );
    const timeOfDayQuery = usePersonalizedHomeFeed(
        25,
        isAuthenticated && timeOfDayMix !== null,
        "for-you",
        timeOfDayMix?.mood ?? null,
        "made-for-you",
    );

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
        dailyMixFeed: dailyMixQuery.data ?? null,
        timeOfDayFeed: timeOfDayQuery.data ?? null,
        timeOfDayMix,
        isLoading: !isAuthenticated || (!hasPrimaryData && allPrimaryLoading),
        isRefreshingMixes,
        isPersonalizedLoading: personalizedQuery.isLoading,
        isPersonalizedUnavailable: personalizedQuery.isError,
        handleRefreshMixes,
    };
}
