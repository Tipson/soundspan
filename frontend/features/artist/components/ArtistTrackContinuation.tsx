import { pluralRu } from "@/lib/i18n/ru";
import { artistRu } from "@/lib/i18n/musicPagesRu";

interface ArtistTrackContinuationProps {
    visibleTrackCount: number;
    library?: {
        loaded: number;
        total: number;
        isFetching: boolean;
        loadMore: () => unknown;
    };
    provider?: {
        loadedReleases: number;
        totalReleases: number;
        isFetching: boolean;
        loadMore: () => unknown;
    };
}

/** Present every catalog source behind one honest progressive continuation. */
export function ArtistTrackContinuation({
    visibleTrackCount,
    library,
    provider,
}: ArtistTrackContinuationProps) {
    if (!library && !provider) return null;

    const isFetching =
        Boolean(library?.isFetching) || Boolean(provider?.isFetching);
    const progress = [
        `сейчас показано: ${visibleTrackCount} ${pluralRu(visibleTrackCount, ["трек", "трека", "треков"])}`,
        library
            ? `${library.loaded} из ${library.total} треков коллекции загружено`
            : null,
        provider
            ? `проверено релизов: ${provider.loadedReleases} из ${provider.totalReleases}`
            : null,
    ].filter((part): part is string => Boolean(part));

    return (
        <section
            aria-label="Продолжение каталога треков"
            className="-mt-5 flex flex-col items-center border-t border-white/[0.08] pt-5 text-center"
        >
            <button
                type="button"
                aria-label="Загрузить следующую часть каталога треков"
                onClick={() => {
                    if (library) void library.loadMore();
                    if (provider) void provider.loadMore();
                }}
                disabled={isFetching}
                className="min-h-11 rounded-full border border-white/15 bg-white/[0.04] px-5 text-sm font-semibold text-white transition duration-200 hover:border-white/25 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-light disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
            >
                {isFetching ? artistRu.loadingTracks : "Показать ещё треки"}
            </button>
            <p
                role="status"
                className="mt-2 text-xs leading-5 text-content-muted"
            >
                Каталог загружается постепенно · {progress.join(" · ")}
            </p>
        </section>
    );
}
