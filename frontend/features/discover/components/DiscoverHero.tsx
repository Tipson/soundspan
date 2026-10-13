import { Sparkles } from "lucide-react";
import { MusicDetailHero } from "@/components/music-detail";
import { CoverMosaic } from "@/components/ui/CoverMosaic";
import { api } from "@/lib/api";
import { DiscoverPlaylist, DiscoverConfig } from "../types";
import {
    discoverRu,
    discoverTrackCount,
    formatDiscoverDate,
    formatDiscoverDuration,
} from "@/lib/i18n/discoverRu";

interface DiscoverHeroProps {
    playlist: DiscoverPlaylist | null;
    config: DiscoverConfig | null;
}

/** Weekly discovery identity uses artwork and metadata from its actual tracks. */
export function DiscoverHero({ playlist, config }: DiscoverHeroProps) {
    const totalDuration =
        playlist?.tracks?.reduce((sum, t) => sum + (t.duration || 0), 0) || 0;
    const coverUrls = (playlist?.tracks ?? [])
        .flatMap((track) =>
            track.coverUrl ? [api.getCoverArtUrl(track.coverUrl, 400)] : [],
        )
        .slice(0, 4);

    return (
        <MusicDetailHero
            eyebrow={discoverRu.type}
            title={discoverRu.name}
            artworkShape="square"
            className="-mx-4 md:-mx-8"
            backgroundImage={coverUrls[0] ?? null}
            artwork={
                <CoverMosaic
                    coverUrls={coverUrls}
                    imageSizes="(max-width: 640px) 160px, (max-width: 1024px) 192px, 224px"
                    emptyState={
                        <Sparkles
                            className="h-14 w-14 text-brand-light"
                            aria-hidden="true"
                        />
                    }
                />
            }
            description={<p>{discoverRu.description}</p>}
            metadata={
                <>
                    {playlist ? (
                        <>
                            <span>
                                {discoverRu.weekOf}{" "}
                                {formatDiscoverDate(playlist.weekStart, true)}
                            </span>
                            <span aria-hidden="true">•</span>
                            <span>
                                {discoverTrackCount(playlist.totalCount)}
                            </span>
                            {totalDuration > 0 && (
                                <>
                                    <span aria-hidden="true">•</span>
                                    <span>
                                        {formatDiscoverDuration(totalDuration)}
                                    </span>
                                </>
                            )}
                        </>
                    ) : (
                        <span>Еженедельный персональный подбор</span>
                    )}
                    {config?.lastGeneratedAt && (
                        <>
                            <span aria-hidden="true">•</span>
                            <span>
                                {discoverRu.updated}{" "}
                                {formatDiscoverDate(config.lastGeneratedAt)}
                            </span>
                        </>
                    )}
                </>
            }
        />
    );
}
