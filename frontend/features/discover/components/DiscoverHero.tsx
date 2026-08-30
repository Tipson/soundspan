import { Music2, Zap } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
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

/**
 * Renders the DiscoverHero component.
 */
export function DiscoverHero({ playlist, config }: DiscoverHeroProps) {
    // Calculate total duration
    const totalDuration =
        playlist?.tracks?.reduce((sum, t) => sum + (t.duration || 0), 0) || 0;

    const coverUrl = playlist?.tracks?.[0]?.coverUrl
        ? api.getCoverArtUrl(playlist.tracks[0].coverUrl, 200)
        : null;

    return (
        <div className="relative bg-gradient-to-b from-blue-900/40 via-surface-hover to-transparent pt-16 pb-10 px-4 md:px-8">
            <div className="flex items-end gap-6">
                {/* Cover Art */}
                <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-surface-highlight rounded shadow-2xl shrink-0 overflow-hidden relative">
                    {coverUrl ? (
                        <CachedImage
                            src={coverUrl}
                            alt={discoverRu.name}
                            fill
                            className="object-cover"
                            sizes="192px"
                        />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-ai-dark/30 to-yellow-600/20 border border-white/10">
                            <Music2 className="w-16 h-16 md:w-20 md:h-20 text-ai-hover" />
                        </div>
                    )}
                    <div className="absolute bottom-2 right-2 drop-shadow-lg">
                        <Zap
                            className="w-7 h-7 text-pink-500"
                            strokeWidth={2.5}
                        />
                    </div>
                </div>

                {/* Info - Bottom Aligned */}
                <div className="flex-1 min-w-0 pb-1">
                    <p className="text-xs font-medium text-white/90 mb-1">
                        {discoverRu.type}
                    </p>
                    <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                        {discoverRu.name}
                    </h1>
                    <p className="text-sm text-white/60 mb-2 line-clamp-2">
                        {discoverRu.description}
                    </p>
                    <div className="flex flex-wrap items-center gap-1 text-sm text-white/70">
                        {playlist && (
                            <>
                                <span>
                                    {discoverRu.weekOf}{" "}
                                    {formatDiscoverDate(
                                        playlist.weekStart,
                                        true,
                                    )}
                                </span>
                                <span className="mx-1">•</span>
                                <span>
                                    {discoverTrackCount(playlist.totalCount)}
                                </span>
                                {totalDuration > 0 && (
                                    <span>
                                        ,{" "}
                                        {formatDiscoverDuration(totalDuration)}
                                    </span>
                                )}
                            </>
                        )}
                        {config?.lastGeneratedAt && (
                            <>
                                <span className="mx-1">•</span>
                                <span>
                                    {discoverRu.updated}{" "}
                                    {formatDiscoverDate(config.lastGeneratedAt)}
                                </span>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
