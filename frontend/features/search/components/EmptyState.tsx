import { Search as SearchIcon } from "lucide-react";
import { ru } from "@/lib/i18n/ru";

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
            className="relative flex min-h-72 items-center justify-center px-4 py-12 text-center sm:min-h-80 sm:px-6"
        >
            <div className="relative max-w-xl">
                <span className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-[14px] bg-surface-active text-content-secondary">
                    <SearchIcon className="h-6 w-6" aria-hidden="true" />
                </span>
                <h1
                    id="search-welcome-title"
                    className="text-balance text-2xl font-bold tracking-[-0.03em] text-content sm:text-4xl"
                >
                    {ru.search.welcomeTitle}
                </h1>
                <p className="mx-auto mt-4 max-w-md text-pretty text-sm leading-6 text-content-secondary sm:text-base">
                    {ru.search.welcomeDescription}
                </p>
            </div>
        </section>
    );
}
