"use client";

import { PlayableCard } from "@/components/ui/PlayableCard";
import { Disc3 } from "lucide-react";
import { api } from "@/lib/api";
import type { Album } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { PeerBadge } from "@/components/ui/PeerBadge";
import { pluralRu, ru } from "@/lib/i18n/ru";

interface DiscographyProps {
    albums: Album[];
    colors: ColorPalette | null;
    onPlayAlbum: (albumId: string, albumTitle: string) => Promise<void>;
    sortBy: "year" | "dateAdded";
    onSortChange: (sortBy: "year" | "dateAdded") => void;
    title?: string;
}

/**
 * Renders the Discography component.
 */
export function Discography({
    albums,
    colors,
    onPlayAlbum,
    sortBy,
    onSortChange,
    title = ru.catalog.discography,
}: DiscographyProps) {
    if (!albums || albums.length === 0) {
        return null;
    }

    return (
        <section>
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                <h2 className="text-2xl font-black tracking-[-0.03em] sm:text-3xl">
                    {title}
                </h2>
                {/* Sort Dropdown */}
                <select
                    value={sortBy}
                    aria-label="Сортировка дискографии"
                    onChange={(e) =>
                        onSortChange(e.target.value as "year" | "dateAdded")
                    }
                    className="min-h-11 rounded-full border border-white/10 bg-white/5 px-4 text-sm font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light [&>option]:bg-surface-hover [&>option]:text-white"
                >
                    <option value="year">{ru.catalog.yearNewest}</option>
                    <option value="dateAdded">
                        {ru.catalog.dateAddedRecent}
                    </option>
                </select>
            </div>
            <div
                data-tv-section="discography"
                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4"
            >
                {albums.map((album, index) => {
                    const subtitle = [
                        album.year,
                        album.trackCount &&
                            `${album.trackCount} ${pluralRu(album.trackCount, ["трек", "трека", "треков"])}`,
                    ]
                        .filter(Boolean)
                        .join(" • ");

                    return (
                        <PlayableCard
                            key={album.id}
                            href={`/album/${album.id}`}
                            coverArt={
                                album.coverArt
                                    ? api.getCoverArtUrl(album.coverArt, 300)
                                    : null
                            }
                            title={album.title}
                            subtitle={subtitle}
                            placeholderIcon={
                                <Disc3 className="w-12 h-12 text-gray-400" />
                            }
                            badge={
                                album.provenanceSource === "federated" &&
                                album.peer ? (
                                    <PeerBadge
                                        peerName={album.peer.name}
                                        online={album.peer.online}
                                    />
                                ) : (
                                    "owned"
                                )
                            }
                            circular={false}
                            colors={colors}
                            onPlay={
                                album.provenanceSource === "federated" &&
                                album.peer?.online === false
                                    ? undefined
                                    : () => onPlayAlbum(album.id, album.title)
                            }
                            showPlayButton={
                                album.provenanceSource !== "federated" ||
                                album.peer?.online === true
                            }
                            tvCardIndex={index}
                        />
                    );
                })}
            </div>
        </section>
    );
}
