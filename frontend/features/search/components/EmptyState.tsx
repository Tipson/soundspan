import { Search as SearchIcon } from "lucide-react";

interface EmptyStateProps {
    hasSearched: boolean;
    isLoading: boolean;
}

/**
 * Renders the EmptyState component.
 */
export function EmptyState({ hasSearched, isLoading }: EmptyStateProps) {
    if (isLoading || hasSearched) {
        return null;
    }

    return (
        <section
            data-search-welcome="true"
            aria-labelledby="search-welcome-title"
            className="relative isolate flex min-h-[52vh] items-center justify-center overflow-hidden rounded-[1.75rem] border border-white/[0.08] bg-white/[0.025] px-6 py-16 text-center sm:min-h-[58vh] sm:px-10"
        >
            <div
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/10 blur-3xl"
            />
            <div className="relative max-w-xl">
                <span className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.05] text-brand-light shadow-lg shadow-black/20">
                    <SearchIcon className="h-6 w-6" aria-hidden="true" />
                </span>
                <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-content-muted">
                    One search, every source
                </p>
                <h1
                    id="search-welcome-title"
                    className="text-balance text-3xl font-black tracking-[-0.045em] text-content sm:text-5xl"
                >
                    Find anything you want to hear
                </h1>
                <p className="mx-auto mt-4 max-w-md text-pretty text-sm leading-6 text-content-secondary sm:text-base">
                    Search tracks, artists, and albums across your saved music
                    and the online catalog.
                </p>
            </div>
        </section>
    );
}
