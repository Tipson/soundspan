import { FilterChip } from "@/components/ui/FilterChip";
import type { SearchResultView } from "../types";

interface SearchFiltersProps {
    activeView: SearchResultView;
    query: string;
    hasSearched: boolean;
}

const SEARCH_RESULT_VIEWS: ReadonlyArray<{
    id: SearchResultView;
    label: string;
}> = [
    { id: "all", label: "All" },
    { id: "tracks", label: "Tracks" },
    { id: "artists", label: "Artists" },
    { id: "albums", label: "Albums" },
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
            aria-label="Search result type"
            className="sticky top-0 z-30 -mx-4 mb-8 overflow-x-auto border-b border-white/[0.06] bg-surface/85 px-4 py-3 backdrop-blur-xl scrollbar-hide sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
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
                            className="min-h-10"
                        >
                            {view.label}
                        </FilterChip>
                    );
                })}
            </div>
        </nav>
    );
}
