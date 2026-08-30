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
            className="sticky top-2 z-30 mb-7 overflow-x-auto rounded-2xl border border-white/[0.08] bg-black/60 p-2 shadow-[0_18px_48px_rgb(0_0_0/0.2)] backdrop-blur-xl scrollbar-hide sm:mb-9"
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
                            className="min-h-11 px-4"
                        >
                            {view.label}
                        </FilterChip>
                    );
                })}
            </div>
        </nav>
    );
}
