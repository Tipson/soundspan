"use client";

import { Loader2 } from "lucide-react";
import { RadioStationMosaic } from "@/app/radio/RadioStationMosaic";

export interface RadioStationCardStation {
    id: string;
    name: string;
    description: string;
    color: string;
    filter: {
        type:
            | "genre"
            | "decade"
            | "discovery"
            | "favorites"
            | "all"
            | "workout"
            | "liked";
        value?: string;
    };
    minTracks?: number;
}

interface RadioStationCardProps {
    station: RadioStationCardStation;
    onPlay: () => void;
    isLoading: boolean;
}

/**
 * Square radio station card with mosaic cover art, gradient overlay,
 * and title + description below. The whole card is the click target;
 * a spinner appears over the art while the station opens.
 */
export function RadioStationCard({
    station,
    onPlay,
    isLoading,
}: RadioStationCardProps) {
    const handlePlayClick = () => {
        if (isLoading) {
            return;
        }
        onPlay();
    };

    return (
        <button
            onClick={handlePlayClick}
            disabled={isLoading}
            className="group min-h-11 w-full cursor-pointer rounded-xl p-1.5 text-left transition duration-200 hover:-translate-y-0.5 hover:bg-surface-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-wait disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none sm:p-2"
        >
            {/* Square cover art */}
            <div className="relative mb-3 aspect-square overflow-hidden rounded-xl bg-surface-highlight shadow-lg shadow-black/20">
                <RadioStationMosaic
                    filter={station.filter}
                    className="absolute inset-0"
                />
                {/* Gradient tint overlay */}
                <div
                    className={`absolute inset-0 bg-gradient-to-br ${station.color} opacity-40 pointer-events-none`}
                />
                {/* Loading spinner — bottom-right, only while the station opens */}
                {isLoading && (
                    <div className="absolute bottom-2 right-2">
                        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-hover shadow-xl">
                            <Loader2 className="h-4 w-4 animate-spin text-surface motion-reduce:animate-none" />
                        </div>
                    </div>
                )}
            </div>
            {/* Title + description below art */}
            <h3 className="truncate text-sm font-semibold text-content">
                {station.name}
            </h3>
            <p className="mt-0.5 truncate text-xs text-content-muted">
                {station.description}
            </p>
        </button>
    );
}
