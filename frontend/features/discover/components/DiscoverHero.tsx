import { Sparkles } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
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

    return (
        <div>
            <PageHeader
                title={discoverRu.name}
                subtitle={discoverRu.description}
                icon={Sparkles}
                iconClassName="text-ai-hover"
                className="mb-4"
                badge={
                    <span className="rounded-full border border-ai/25 bg-ai/10 px-3 py-1 text-xs font-semibold text-ai-hover">
                        {discoverRu.type}
                    </span>
                }
            />
            <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-content-muted">
                {playlist ? (
                    <>
                        <span>
                            {discoverRu.weekOf}{" "}
                            {formatDiscoverDate(playlist.weekStart, true)}
                        </span>
                        <span aria-hidden="true">•</span>
                        <span>{discoverTrackCount(playlist.totalCount)}</span>
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
            </div>
        </div>
    );
}
