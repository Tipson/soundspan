"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import { cn } from "@/utils/cn";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { CoverMosaic } from "@/components/ui/CoverMosaic";
import {
    createRadioMosaicCandidates,
    selectRadioMosaicTiles,
} from "./radioStationMosaicSelection";

export type RadioStationFilterType =
    | "genre"
    | "decade"
    | "discovery"
    | "favorites"
    | "all"
    | "workout"
    | "liked";

export interface RadioStationFilter {
    type: RadioStationFilterType;
    value?: string;
}

interface RadioStationMosaicProps {
    filter: RadioStationFilter;
    className?: string;
    tileCount?: number;
}

/**
 * Renders station-specific artwork as a single random album cover (re-rolled daily).
 */
export function RadioStationMosaic({
    filter,
    className,
    tileCount = 1,
}: RadioStationMosaicProps) {
    const dailySeed = new Date().toISOString().slice(0, 10);

    const { data: tiles, isLoading } = useQuery({
        queryKey: queryKeys.radioMosaic(
            filter.type,
            filter.value ?? "",
            tileCount,
            dailySeed,
        ),
        queryFn: async () => {
            try {
                const response = await api.getRadioTracks(
                    filter.type,
                    filter.value,
                    96,
                );
                const candidates = createRadioMosaicCandidates(
                    (response.tracks || []) as Track[],
                );
                return selectRadioMosaicTiles(candidates, tileCount);
            } catch (error) {
                sharedFrontendLogger.error(
                    "[RadioStationMosaic] Failed to fetch station tracks:",
                    error,
                );
                return [];
            }
        },
        staleTime: 24 * 60 * 60 * 1000,
    });

    const coverUrls = useMemo(
        () =>
            (tiles || []).map((tile) => api.getCoverArtUrl(tile.coverArt, 200)),
        [tiles],
    );

    return (
        <div className={cn("w-full h-full", className)}>
            <CoverMosaic
                coverUrls={coverUrls}
                layout="2x2"
                isLoading={isLoading}
                hoverScale
                imageSizes="(max-width: 768px) 120px, 180px"
                emptyState={
                    <div className="flex h-full w-full items-center justify-center bg-linear-to-br from-surface-highlight to-surface">
                        <Music className="h-10 w-10 text-content-muted" />
                    </div>
                }
            />
        </div>
    );
}
