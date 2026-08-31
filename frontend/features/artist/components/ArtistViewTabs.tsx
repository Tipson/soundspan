import { FilterChip } from "@/components/ui/FilterChip";
import type { ArtistView } from "../artistView";
import { ru } from "@/lib/i18n/ru";

export { filterArtistReleases, resolveArtistView } from "../artistView";
export type { ArtistView } from "../artistView";

interface ArtistViewTabsProps {
    activeView: ArtistView;
    pathname: string;
    searchParams: string;
}

const VIEW_OPTIONS: ReadonlyArray<{
    value: ArtistView;
    label: string;
}> = [
    { value: "overview", label: ru.catalog.overview },
    { value: "tracks", label: ru.catalog.tracks },
    { value: "albums", label: ru.catalog.albums },
    { value: "singles", label: ru.catalog.singles },
];

/** Build an artist-view URL while preserving provider query parameters. */
export function buildArtistViewHref(
    pathname: string,
    searchParams: string,
    view: ArtistView,
): string {
    const params = new URLSearchParams(searchParams);
    params.set("view", view);
    return `${pathname}?${params.toString()}`;
}

/** Render URL-addressable content filters on an artist page. */
export function ArtistViewTabs({
    activeView,
    pathname,
    searchParams,
}: ArtistViewTabsProps) {
    return (
        <nav
            aria-label={ru.catalog.artistContentAria}
            data-overflow-cue="horizontal"
            className="scrollbar-hide snap-x snap-mandatory overflow-x-auto"
        >
            <div className="flex min-w-max gap-2 py-1">
                {VIEW_OPTIONS.map((option) => (
                    <FilterChip
                        key={option.value}
                        active={activeView === option.value}
                        href={buildArtistViewHref(
                            pathname,
                            searchParams,
                            option.value,
                        )}
                        className="min-h-11 snap-start px-4"
                    >
                        {option.label}
                    </FilterChip>
                ))}
            </div>
        </nav>
    );
}
