"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AudioLines } from "lucide-react";
import { useAudioControls } from "@/lib/audio-controls-context";
import { openRadioStation } from "@/lib/radio/openRadioStation";
import {
    useRadioPageStations,
    type RadioPageStation,
} from "@/lib/radio/radioPageStations";
import { PageHeader } from "@/components/layout/PageHeader";
import { RadioStationCard } from "@/components/ui/RadioStationCard";
import { radioRu } from "@/lib/i18n/utilityPagesRu";

// Static radio stations
const STATIC_STATIONS: RadioPageStation[] = [
    {
        id: "all",
        name: radioRu.allName,
        description: radioRu.allDescription,
        color: "from-brand/35 to-surface-highlight/40",
        filter: { type: "all" },
        minTracks: 10,
    },
    {
        id: "workout",
        name: radioRu.workoutName,
        description: radioRu.workoutDescription,
        color: "from-error/30 to-warning/25",
        filter: { type: "workout" },
        minTracks: 15,
    },
    {
        id: "discovery",
        name: radioRu.discoveryName,
        description: radioRu.discoveryDescription,
        color: "from-success/25 to-brand/20",
        filter: { type: "discovery" },
        minTracks: 20,
    },
    {
        id: "favorites",
        name: radioRu.favoritesName,
        description: radioRu.favoritesDescription,
        color: "from-error/25 to-surface-highlight/40",
        filter: { type: "favorites" },
        minTracks: 10,
    },
];

// Section Header Component
function SectionHeader({
    title,
    description,
}: {
    title: string;
    description?: string;
}) {
    return (
        <div className="mb-5 max-w-2xl">
            <h2 className="text-2xl font-black tracking-[-0.03em] text-content sm:text-3xl">
                {title}
            </h2>
            {description && (
                <p className="mt-1 text-sm leading-6 text-content-muted">
                    {description}
                </p>
            )}
        </div>
    );
}

function StationGridSkeleton() {
    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
                <div
                    key={i}
                    className="aspect-square animate-pulse rounded-xl bg-surface-elevated motion-reduce:animate-none"
                />
            ))}
        </div>
    );
}

function StationGrid({
    stations,
    loadingStation,
    onOpen,
}: {
    stations: RadioPageStation[];
    loadingStation: string | null;
    onOpen: (station: RadioPageStation) => void;
}) {
    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {stations.map((station) => (
                <RadioStationCard
                    key={station.id}
                    station={station}
                    onPlay={() => onOpen(station)}
                    isLoading={loadingStation === station.id}
                />
            ))}
        </div>
    );
}

/**
 * Renders the RadioPage component.
 */
export default function RadioPage() {
    const router = useRouter();
    const { playTracks } = useAudioControls();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);
    const { genreStations, decadeStations, isLoading } = useRadioPageStations();

    const handleStation = async (station: RadioPageStation) => {
        setLoadingStation(station.id);
        try {
            await openRadioStation(station, {
                push: router.push,
                playTracks,
            });
        } finally {
            setLoadingStation(null);
        }
    };

    return (
        <div
            data-consumer-surface="radio"
            className="relative min-h-screen bg-surface"
        >
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-brand/70 to-transparent"
            />

            <div
                data-radio-stage="open"
                className="relative mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8"
            >
                {/* Header */}
                <PageHeader
                    title={radioRu.title}
                    subtitle={radioRu.subtitle}
                    icon={AudioLines}
                    className="mb-8"
                />

                {/* Quick Start Section */}
                <section className="mb-12 border-t border-line pt-7">
                    <SectionHeader
                        title={radioRu.quickStart}
                        description={radioRu.quickStartDescription}
                    />
                    <StationGrid
                        stations={STATIC_STATIONS}
                        loadingStation={loadingStation}
                        onOpen={handleStation}
                    />
                </section>

                {/* Genres Section */}
                {(isLoading || genreStations.length > 0) && (
                    <section className="mb-12 border-t border-line pt-7">
                        <SectionHeader
                            title={radioRu.byGenre}
                            description={radioRu.byGenreDescription}
                        />
                        {isLoading ? (
                            <StationGridSkeleton />
                        ) : (
                            <StationGrid
                                stations={genreStations}
                                loadingStation={loadingStation}
                                onOpen={handleStation}
                            />
                        )}
                    </section>
                )}

                {/* Decades Section - Only show if there are decade stations */}
                {(isLoading || decadeStations.length > 0) && (
                    <section className="mb-12 border-t border-line pt-7">
                        <SectionHeader
                            title={radioRu.byDecade}
                            description={radioRu.byDecadeDescription}
                        />
                        {isLoading ? (
                            <StationGridSkeleton />
                        ) : (
                            <StationGrid
                                stations={decadeStations}
                                loadingStation={loadingStation}
                                onOpen={handleStation}
                            />
                        )}
                    </section>
                )}

                {/* Info */}
                <aside className="mt-12 border-y border-line py-5">
                    <h3 className="mb-2 text-sm font-semibold text-content">
                        {radioRu.aboutTitle}
                    </h3>
                    <p className="max-w-3xl text-sm leading-6 text-content-muted">
                        {radioRu.aboutDescription}
                    </p>
                </aside>
            </div>
        </div>
    );
}
