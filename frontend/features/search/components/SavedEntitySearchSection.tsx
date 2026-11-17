import { SavedMusicGrid } from "@/features/library/components/SavedMusicGrid";
import type { SavedMusicEntityType } from "@/lib/api";
import type { SavedEntitySearchState } from "../hooks/useSavedEntitySearch";
import { SearchSectionHeader } from "./SearchSectionHeader";

interface SavedEntitySearchSectionProps {
    type: SavedMusicEntityType;
    result: Pick<
        SavedEntitySearchState,
        "items" | "hasNextPage" | "isFetchingNextPage" | "fetchNextPage"
    >;
    preview: boolean;
    onViewAll: () => void;
}

/** Explicit collection matches retain their existing cards and exact browse routes. */
export function SavedEntitySearchSection({
    type,
    result,
    preview,
    onViewAll,
}: SavedEntitySearchSectionProps) {
    if (!result.items.length && !result.hasNextPage) return null;
    const album = type === "album";
    const more = result.hasNextPage || result.items.length > 6;
    const label = album ? "Сохранённые альбомы" : "Сохранённые исполнители";
    return (
        <section
            aria-label={label}
            className="min-w-0 border-t border-white/[0.08] pt-5"
        >
            <SearchSectionHeader
                title={label}
                description="Из вашей коллекции"
                status={
                    preview && more ? (
                        <button
                            type="button"
                            onClick={onViewAll}
                            aria-label={
                                album
                                    ? "Все сохранённые альбомы"
                                    : "Все сохранённые исполнители"
                            }
                            className="min-h-11 rounded-full px-4 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                        >
                            {album ? "Все альбомы" : "Все исполнители"}
                        </button>
                    ) : undefined
                }
            />
            {result.items.length > 0 ? (
                <SavedMusicGrid
                    type={type}
                    items={preview ? result.items.slice(0, 6) : result.items}
                    isLoading={false}
                    isError={false}
                />
            ) : null}
            {!preview && result.hasNextPage ? (
                <div className="flex justify-center pt-4">
                    <button
                        type="button"
                        onClick={() => void result.fetchNextPage()}
                        disabled={result.isFetchingNextPage}
                        aria-label={
                            album
                                ? "Показать ещё сохранённые альбомы"
                                : "Показать ещё сохранённых исполнителей"
                        }
                        className="min-h-11 max-w-full rounded-full border border-white/15 px-5 py-2 text-sm font-semibold text-content-secondary transition-colors hover:bg-white/[0.06] hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-wait disabled:opacity-60"
                    >
                        {result.isFetchingNextPage
                            ? "Загружаем…"
                            : album
                              ? "Показать ещё альбомы"
                              : "Показать ещё исполнителей"}
                    </button>
                </div>
            ) : null}
        </section>
    );
}
