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
        color: "from-brand/40 to-sky-400/30",
        filter: { type: "all" },
        minTracks: 10,
    },
    {
        id: "workout",
        name: radioRu.workoutName,
        description: radioRu.workoutDescription,
        color: "from-red-500/30 to-orange-600/30",
        filter: { type: "workout" },
        minTracks: 15,
    },
    {
        id: "discovery",
        name: radioRu.discoveryName,
        description: radioRu.discoveryDescription,
        color: "from-emerald-500/30 to-teal-600/30",
        filter: { type: "discovery" },
        minTracks: 20,
    },
    {
        id: "favorites",
        name: radioRu.favoritesName,
        description: radioRu.favoritesDescription,
        color: "from-rose-500/30 to-pink-600/30",
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
        <div className="mb-4">
            <h2 className="text-xl font-bold text-white">{title}</h2>
            {description && (
                <p className="text-sm text-white/50 mt-1">{description}</p>
            )}
        </div>
    );
}

function StationGridSkeleton() {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
                <div
                    key={i}
                    className="aspect-square rounded-lg bg-white/5 animate-pulse"
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
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
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
        <div className="min-h-screen relative">
            {/* Hero gradient */}
            <div
                className="absolute top-0 left-0 right-0 pointer-events-none"
                style={{
                    background:
                        "linear-gradient(to bottom, rgba(59, 130, 246, 0.15) 0%, rgba(139, 92, 246, 0.08) 40%, transparent 100%)",
                    height: "35vh",
                }}
            />
            <div
                className="absolute top-0 left-0 right-0 pointer-events-none"
                style={{
                    background:
                        "radial-gradient(ellipse at top, rgba(59, 130, 246, 0.1) 0%, transparent 70%)",
                    height: "25vh",
                }}
            />

            {/* Content */}
            <div className="relative px-4 md:px-8 py-6">
                {/* Header */}
                <PageHeader
                    title={radioRu.title}
                    subtitle={radioRu.subtitle}
                    icon={AudioLines}
                    className="mb-8"
                />

                {/* Quick Start Section */}
                <section className="mb-10">
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
                    <section className="mb-10">
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
                    <section className="mb-10">
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
                <div className="mt-12 p-4 rounded-lg bg-white/5 border border-white/10">
                    <h3 className="text-sm font-semibold text-white mb-2">
                        {radioRu.aboutTitle}
                    </h3>
                    <p className="text-sm text-white/60">
                        {radioRu.aboutDescription}
                    </p>
                </div>
            </div>
        </div>
    );
}
