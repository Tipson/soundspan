import { FeaturedShelvesSection } from "@/features/explore/components/FeaturedShelvesSection";
import { MoodsGenresSection } from "@/features/explore/components/MoodsGenresSection";
import { YtMusicMixesSection } from "@/features/explore/components/YtMusicMixesSection";
import { FeaturedPlaylistsGrid } from "./FeaturedPlaylistsGrid";
import { SectionHeader } from "./SectionHeader";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import type {
    PlaylistPreview,
    YtMusicCategory,
    YtMusicHomeShelf,
    YtMusicMixPreview,
} from "@/hooks/useQueries";

interface HomeOnlineDiscoveryProps {
    enabled: boolean;
    ytMusicMixes: YtMusicMixPreview[];
    moodCategories: YtMusicCategory[];
    genreCategories: YtMusicCategory[];
    isMoodsLoading: boolean;
    homeShelves: YtMusicHomeShelf[];
    chartPlaylists: PlaylistPreview[];
}

/** Live online-catalog discovery embedded in the primary Home feed. */
export function HomeOnlineDiscovery({
    enabled,
    ytMusicMixes,
    moodCategories,
    genreCategories,
    isMoodsLoading,
    homeShelves,
    chartPlaylists,
}: HomeOnlineDiscoveryProps) {
    if (!enabled) return null;

    const hasProviderContent =
        isMoodsLoading ||
        ytMusicMixes.length > 0 ||
        moodCategories.length > 0 ||
        genreCategories.length > 0 ||
        homeShelves.length > 0 ||
        chartPlaylists.length > 0;

    if (!hasProviderContent) return null;

    return (
        <section
            aria-labelledby="home-online-discovery-title"
            className="space-y-7 border-t border-white/8 pt-7 sm:space-y-9 sm:pt-9"
        >
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-light">
                        Online catalog
                    </p>
                    <h2
                        id="home-online-discovery-title"
                        className="mt-1 text-2xl font-black tracking-[-0.03em] text-content sm:text-3xl"
                    >
                        Explore music
                    </h2>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-content-secondary">
                        Real mixes, categories, releases, and charts from the
                        connected catalog.
                    </p>
                </div>
                <YouTubeBadge />
            </header>

            <YtMusicMixesSection mixes={ytMusicMixes} />
            <MoodsGenresSection
                moodCategories={moodCategories}
                genreCategories={genreCategories}
                isLoading={isMoodsLoading}
            />
            <FeaturedShelvesSection homeShelves={homeShelves} />
            {chartPlaylists.length > 0 && (
                <section>
                    <SectionHeader title="Charts" badge={<YouTubeBadge />} />
                    <FeaturedPlaylistsGrid playlists={chartPlaylists} />
                </section>
            )}
        </section>
    );
}
