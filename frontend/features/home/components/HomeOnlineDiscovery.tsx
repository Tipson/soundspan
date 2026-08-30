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

const REGIONAL_DUMP_PATTERN =
    /(?:\b(?:schlager|german|germany|deutsch(?:e|land)?)\b|немецк(?:ая|ие|ой|ую)|германи(?:я|и|ю))/i;
const PERSONAL_SHELF_PATTERN =
    /(?:\b(?:for you|made for you|because you|recommended|listen again|your mix|quick picks)\b|для вас|сделано для вас|ваш(?:и|у)? микс|слушать снова)/i;
const DISCOVERY_SHELF_PATTERN =
    /(?:\b(?:new releases?|discover|trending|popular|charts?)\b|новинки|открытия|популярн|чарты?)/i;

function shelfScore(shelf: YtMusicHomeShelf): number {
    const title = shelf.title ?? "";
    if (PERSONAL_SHELF_PATTERN.test(title)) return 2;
    if (DISCOVERY_SHELF_PATTERN.test(title)) return 1;
    return 0;
}

/** Keeps Home focused: navigable, unique, non-regional shelves, at most three. */
export function curateHomeShelves(
    shelves: YtMusicHomeShelf[],
): YtMusicHomeShelf[] {
    const seenTitles = new Set<string>();

    return shelves
        .map((shelf, sourceIndex) => {
            const seenItems = new Set<string>();
            const contents = (shelf.contents ?? [])
                .filter(
                    (item) =>
                        Boolean(item.playlistId) ||
                        (Boolean(item.browseId) && item.type === "album"),
                )
                .filter((item) => {
                    const key = item.playlistId ?? item.browseId;
                    if (!key || seenItems.has(key)) return false;
                    seenItems.add(key);
                    return true;
                })
                .slice(0, 8);

            return { shelf, sourceIndex, contents };
        })
        .filter(({ shelf, contents }) => {
            const normalizedTitle = (shelf.title ?? "featured")
                .trim()
                .toLocaleLowerCase();
            if (
                contents.length === 0 ||
                REGIONAL_DUMP_PATTERN.test(normalizedTitle)
            ) {
                return false;
            }
            if (seenTitles.has(normalizedTitle)) return false;
            seenTitles.add(normalizedTitle);
            return true;
        })
        .sort(
            (left, right) =>
                shelfScore(right.shelf) - shelfScore(left.shelf) ||
                left.sourceIndex - right.sourceIndex,
        )
        .slice(0, 3)
        .map(({ shelf, contents }) => ({ ...shelf, contents }));
}

function curateCategories(categories: YtMusicCategory[]): YtMusicCategory[] {
    return categories
        .map((category) => ({
            ...category,
            items: (category.items ?? []).slice(0, 8),
        }))
        .filter((category) => (category.items?.length ?? 0) > 0)
        .slice(0, 1);
}

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

    const curatedShelves = curateHomeShelves(homeShelves);
    const curatedMoods = curateCategories(moodCategories);
    const curatedGenres = curateCategories(genreCategories);
    const curatedMixes = ytMusicMixes.slice(0, 8);
    const curatedCharts = chartPlaylists.slice(0, 8);

    const hasProviderContent =
        isMoodsLoading ||
        curatedMixes.length > 0 ||
        curatedMoods.length > 0 ||
        curatedGenres.length > 0 ||
        curatedShelves.length > 0 ||
        curatedCharts.length > 0;

    if (!hasProviderContent) return null;

    return (
        <section
            aria-labelledby="home-online-discovery-title"
            className="space-y-8 border-t border-white/[0.07] pt-8 sm:space-y-10 sm:pt-10"
        >
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-content-muted">
                        Beyond your rotation
                    </p>
                    <h2
                        id="home-online-discovery-title"
                        className="mt-1 text-2xl font-black tracking-[-0.03em] text-content sm:text-3xl"
                    >
                        Explore something new
                    </h2>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-content-secondary">
                        A short edit of mixes, releases, and moods from the
                        connected catalog — not an endless category dump.
                    </p>
                </div>
                <YouTubeBadge />
            </header>

            <FeaturedShelvesSection homeShelves={curatedShelves} />
            <YtMusicMixesSection mixes={curatedMixes} />
            <MoodsGenresSection
                moodCategories={curatedMoods}
                genreCategories={curatedGenres}
                isLoading={isMoodsLoading}
            />
            {curatedCharts.length > 0 && (
                <section>
                    <SectionHeader title="Charts" badge={<YouTubeBadge />} />
                    <FeaturedPlaylistsGrid playlists={curatedCharts} />
                </section>
            )}
        </section>
    );
}
