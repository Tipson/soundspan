import Link from "next/link";
import { Album, Loader2, RotateCcw, Search, UserRound } from "lucide-react";
import { CachedImage } from "@/components/ui/CachedImage";
import { api, type SavedMusicEntity } from "@/lib/api";
import { getSavedMusicEntityHref } from "../savedMusicEntity";
import { ru } from "@/lib/i18n/ru";

interface SavedMusicGridProps {
    type: "album" | "artist";
    items: SavedMusicEntity[];
    isLoading: boolean;
    isError: boolean;
    hasMore?: boolean;
    isLoadingMore?: boolean;
    onLoadMore?: () => void;
    onRetry?: () => void;
}

function imageUrl(entity: SavedMusicEntity): string | null {
    if (!entity.imageUrl) return null;
    if (entity.source === "ytmusic") {
        return api.getBrowseImageUrl(entity.imageUrl);
    }
    if (entity.source === "tidal") {
        return api.getTidalBrowseImageUrl(entity.imageUrl);
    }
    return api.getCoverArtUrl(entity.imageUrl, 400);
}

function SavedMusicSkeleton() {
    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
            {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="space-y-3 p-2">
                    <div className="aspect-square animate-pulse rounded-2xl bg-white/[0.06]" />
                    <div className="h-4 w-3/4 animate-pulse rounded bg-white/[0.06]" />
                </div>
            ))}
        </div>
    );
}

/** Account-saved album/artist cards that preserve exact provider routes. */
export function SavedMusicGrid({
    type,
    items,
    isLoading,
    isError,
    hasMore = false,
    isLoadingMore = false,
    onLoadMore,
    onRetry,
}: SavedMusicGridProps) {
    if (isLoading) return <SavedMusicSkeleton />;

    if (isError) {
        return (
            <div
                role="alert"
                className="flex flex-col items-center rounded-2xl border border-warning/20 bg-warning/10 px-5 py-8 text-center text-sm text-content-body"
            >
                <p>
                    Не удалось загрузить сохранённые{" "}
                    {type === "album" ? "альбомы" : "исполнителей"}.
                </p>
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-warning/35 px-4 py-2 font-semibold text-warning transition-colors hover:bg-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning motion-reduce:transition-none"
                    >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        {ru.common.retry}
                    </button>
                )}
            </div>
        );
    }

    if (items.length === 0) {
        return (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 px-6 text-center">
                {type === "album" ? (
                    <Album className="mb-4 h-10 w-10 text-content-muted" />
                ) : (
                    <UserRound className="mb-4 h-10 w-10 text-content-muted" />
                )}
                <h2 className="text-lg font-semibold text-content">
                    Пока нет сохранённых{" "}
                    {type === "album" ? "альбомов" : "исполнителей"}
                </h2>
                <p className="mt-2 max-w-md text-sm text-content-muted">
                    Сохраните {type === "album" ? "альбом" : "исполнителя"} в
                    коллекцию на его странице. Коллекция доступна в аккаунте,
                    а офлайн-загрузки выбираются отдельно на каждом устройстве.
                </p>
                <Link
                    href="/search"
                    className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-semibold text-black transition-colors hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transition-none"
                >
                    <Search className="h-4 w-4" aria-hidden="true" />
                    Найти музыку
                </Link>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
            {items.map((entity) => {
                const art = imageUrl(entity);
                const rounded =
                    type === "artist" ? "rounded-full" : "rounded-2xl";
                return (
                    <Link
                        key={entity.id}
                        href={getSavedMusicEntityHref(entity)}
                        className="group min-w-0 rounded-[20px] border border-transparent p-2 transition-[transform,background-color,border-color] hover:-translate-y-0.5 hover:border-white/[0.08] hover:bg-white/[0.045] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light motion-reduce:transform-none motion-reduce:transition-none"
                    >
                        <div
                            className={`relative mb-3 flex aspect-square items-center justify-center overflow-hidden bg-surface-highlight shadow-[0_16px_42px_rgb(0_0_0/0.2)] ring-1 ring-white/[0.06] ${rounded}`}
                        >
                            {type === "artist" ? (
                                <UserRound className="h-10 w-10 text-content-muted" />
                            ) : (
                                <Album className="h-10 w-10 text-content-muted" />
                            )}
                            {art && (
                                <CachedImage
                                    src={art}
                                    alt=""
                                    fill
                                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 16vw"
                                    className="object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                                />
                            )}
                        </div>
                        <h3 className="line-clamp-2 min-h-10 text-sm font-bold leading-5 text-content [overflow-wrap:anywhere] sm:text-base">
                            {entity.title}
                        </h3>
                        <p className="mt-1 truncate text-xs text-content-muted">
                            {entity.subtitle ||
                                (type === "album"
                                    ? ru.catalog.album
                                    : ru.catalog.artist)}
                        </p>
                    </Link>
                );
            })}
            {hasMore && onLoadMore && (
                <div className="col-span-full flex justify-center pt-4">
                    <button
                        type="button"
                        onClick={onLoadMore}
                        disabled={isLoadingMore}
                        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-5 py-2 text-sm font-semibold text-content transition-colors hover:border-white/25 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
                    >
                        {isLoadingMore && (
                            <Loader2
                                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                            />
                        )}
                        Показать ещё{" "}
                        {type === "album" ? "альбомы" : "исполнителей"}
                    </button>
                </div>
            )}
        </div>
    );
}
