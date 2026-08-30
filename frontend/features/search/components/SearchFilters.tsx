import Link from "next/link";
import { cn } from "@/utils/cn";
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
            className="mb-8 overflow-x-auto scrollbar-hide"
            data-tv-section="search-filters"
        >
            <div className="flex min-w-max gap-2">
                {SEARCH_RESULT_VIEWS.map((view, index) => {
                    const isActive = activeView === view.id;
                    return (
                        <Link
                            key={view.id}
                            href={searchViewHref(query, view.id)}
                            aria-current={isActive ? "page" : undefined}
                            data-tv-card
                            data-tv-card-index={index}
                            tabIndex={0}
                            className={cn(
                                "rounded-full px-4 py-2 text-sm font-bold transition-colors",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
                                isActive
                                    ? "bg-brand text-black"
                                    : "bg-surface-highlight text-white hover:bg-surface-elevated",
                            )}
                        >
                            {view.label}
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}
