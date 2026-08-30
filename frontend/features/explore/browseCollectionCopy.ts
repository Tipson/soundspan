/**
 * Pure user-facing copy for TIDAL browse collection pages (playlist / mix).
 * Kept side-effect free so wording stays unit-testable per collection kind.
 */

/** The kind of TIDAL browse collection a page renders. */
export type BrowseCollectionKind = "playlist" | "mix";

/** Title-case label for a collection kind ("Playlist" / "Mix"). */
export function kindTitle(kind: BrowseCollectionKind): string {
    return kind === "playlist" ? "Плейлист" : "Микс";
}

/** Copy bundle used across the browse collection page states. */
export function browseCollectionCopy(kind: BrowseCollectionKind) {
    const genitive = kind === "playlist" ? "плейлист" : "микс";
    return {
        heroLabel: `TIDAL ${kindTitle(kind)}`,
        loadErrorFallback: `Не удалось загрузить ${genitive}`,
        noPlayableTracks: `В этом ${kind === "playlist" ? "плейлисте" : "миксе"} нет доступных треков`,
        notFoundTitle: `${kindTitle(kind)} не найден`,
        notFoundFallback: `${kindTitle(kind)} может быть приватным или уже недоступным.`,
        emptyMessage: `${kindTitle(kind)}, похоже, пуст`,
    };
}

/**
 * Format a collection's total run time ("about 2 hr 5 min" / "45 min").
 */
export function formatTotalDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `около ${hours} ч ${mins} мин`;
    }
    return `${mins} мин`;
}
