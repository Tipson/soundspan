import { FilterChip } from "@/components/ui/FilterChip";
import type { SearchResultView } from "../types";
import { ru } from "@/lib/i18n/ru";

interface SearchFiltersProps {
    activeView: SearchResultView;
    query: string;
    hasSearched: boolean;
}

const SEARCH_RESULT_VIEWS: ReadonlyArray<{
    id: SearchResultView;
    label: string;
}> = [
    { id: "all", label: ru.search.all },
    { id: "tracks", label: ru.search.tracks },
    { id: "artists", label: ru.search.artists },
    { id: "albums", label: ru.search.albums },
];

function searchViewHref(query: string, view: SearchResultView): string {
    const queryString = `q=${encodeURIComponent(query)}`;
    return view === "all"
        ? `/search?${queryString}`
        : `/search?${queryString}&view=${view}`;
}

/**
 * Navigate between entity-scoped views of the same aggregated music search.
 */
export function SearchFilters({
    activeView,
    query,
    hasSearched,
}: SearchFiltersProps) {
    if (!hasSearched) {
        return null;
    }

    return (
        <nav
            aria-label={ru.search.resultTypeAria}
            data-overflow-cue="horizontal"
            className="sticky top-2 z-30 -mx-1 mb-8 snap-x snap-mandatory overflow-x-auto border-y border-white/[0.08] bg-surface/85 px-1 py-2 backdrop-blur-xl scrollbar-hide sm:mb-10"
            data-tv-section="search-filters"
        >
            <div className="flex min-w-max gap-2">
                {SEARCH_RESULT_VIEWS.map((view, index) => {
                    const isActive = activeView === view.id;
                    return (
                        <FilterChip
                            key={view.id}
                            href={searchViewHref(query, view.id)}
                            active={isActive}
                            data-tv-card
                            data-tv-card-index={index}
                            className="min-h-11 snap-start px-4"
                        >
                            {view.label}
                        </FilterChip>
                    );
                })}
            </div>
        </nav>
    );
}
