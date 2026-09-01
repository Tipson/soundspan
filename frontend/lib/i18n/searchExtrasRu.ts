import { pluralRu } from "./ru";

/** Russian copy for secondary search and YouTube Music discovery surfaces. */
export const searchExtrasRu = {
    alias: {
        showing: "Показаны результаты для",
        query: "по запросу",
    },
    youtubePlaylist: {
        unknownArtist: "Неизвестный исполнитель",
        single: "Сингл",
        fallbackTrackTitle: "Трек YouTube Music",
        tableTitle: "Название",
        tableAlbum: "Альбом",
        loadFailed: "Не удалось загрузить плейлист",
        noPlayableTracks: "В этом плейлисте нет доступных треков",
        addSomeToPlaylistFailed: "Не удалось добавить часть треков в плейлист",
        back: "Назад",
        notFound: "Плейлист не найден",
        unavailable: "Возможно, плейлист приватный или больше недоступен.",
        explore: "Открыть подборки",
        albumType: "Альбом YouTube Music",
        playlistType: "Плейлист YouTube Music",
        pause: "Пауза",
        playAll: "Воспроизвести всё",
        shuffle: "Перемешать",
        addAllToQueue: "Добавить всё в очередь",
        addAllToPlaylist: "Добавить всё в плейлист",
        unlikeAll: "Убрать отметку «Нравится» у всех треков",
        likeAll: "Отметить все треки как понравившиеся",
        noTracks: "Треки не найдены",
        empty: "Этот плейлист пуст",
        addingTracks: "Добавляем треки…",
    },
    youtubeDownload: {
        play: "Воспроизвести",
        download: "Скачать",
        downloadAll: "Скачать всё",
        downloading: "Загружаем…",
        cancel: "Отменить",
        channel: "Канал YouTube",
        playlist: "Плейлист YouTube",
        truncationHint:
            "вставьте ссылку на список меньшего размера, чтобы получить все треки",
        unfinishedBackground: "Незавершённые файлы могут загрузиться в фоне.",
        playlistLoadFailed: "Не удалось загрузить плейлист или канал",
        noPreview: "Предпрослушивание YouTube недоступно",
        previewFailed: "Не удалось воспроизвести фрагмент",
        alreadyDownloaded: "Уже загружено — сканируем медиатеку",
        addedToLibrary: "Добавлено в медиатеку — сканируем",
        failed: "Не удалось загрузить",
        progressLost:
            "Не удалось получить прогресс — загрузка продолжается в фоне",
    },
    soulseek: {
        unknownArtist: "Неизвестный исполнитель",
        title: "Файлы для загрузки",
        description: "Мгновенный поток не найден, но эти файлы можно сохранить",
        downloading: "Загружаем",
        download: "Скачать",
        startFailed: "Не удалось начать загрузку",
    },
    tvSearch: {
        label: "Поиск музыки",
        placeholder: "Нажмите Enter, чтобы найти…",
        hint: "Нажмите Enter для поиска",
    },
    artist: {
        type: "Исполнитель",
        fallback: "исполнитель",
        related: "Похожие исполнители",
    },
    podcastFallback: "Подкаст",
    unknownAuthor: "Неизвестный автор",
} as const;

/** Search alias explanation kept as one accessible status sentence. */
export function formatAliasResolution(
    canonical: string,
    original: string,
): string {
    return `Показаны результаты для ${canonical} (по запросу «${original}»)`;
}

/** Accessible action for a playable provider-search row. */
export function formatPlaySearchTrackAria(
    title: string,
    artist: string | null | undefined,
): string {
    return artist
        ? `Воспроизвести «${title}» — ${artist}`
        : `Воспроизвести «${title}»`;
}

/** Accessible action for an unplayable row that opens its artist. */
export function formatGoToSearchArtistAria(
    artist: string | null | undefined,
): string {
    return `Открыть исполнителя ${artist ?? searchExtrasRu.artist.fallback}`;
}

/** Playlist/channel count, including provider truncation metadata. */
export function formatYouTubePlaylistPreviewCount(
    count: number,
    totalCount: number | null | undefined,
    truncated: boolean,
): string {
    if (truncated) {
        const total = totalCount ? ` из ${totalCount}` : "";
        const nounCount = totalCount || count;
        return `Показаны первые ${count}${total} ${pluralRu(nounCount, ["трек", "трека", "треков"])}`;
    }
    return formatYouTubePlaylistTrackCount(count);
}

/** Collapsed remainder beneath a short playlist preview. */
export function formatYouTubePlaylistRemaining(count: number): string {
    return `+${count} ${pluralRu(count, ["трек", "трека", "треков"])}`;
}

/** Aggregate bulk-download cancellation result. */
export function formatYouTubeBulkStopped(
    completed: number,
    total: number,
): string {
    return `Остановлено — загружено ${completed} из ${total}`;
}

/** Aggregate bulk-download success result. */
export function formatYouTubeBulkSuccess(
    completed: number,
    total: number,
): string {
    return `Загружено ${completed} из ${total} — сканируем медиатеку`;
}

/** Aggregate bulk-download partial-success result. */
export function formatYouTubeBulkUnfinished(
    completed: number,
    total: number,
    failed: number,
): string {
    const adjective =
        failed % 10 === 1 && failed % 100 !== 11
            ? "не завершён"
            : "не завершено";
    return `Загружено ${completed} из ${total}, ${adjective} ${failed} ${pluralRu(failed, ["файл", "файла", "файлов"])}`;
}

/** Description for a chart item while preserving artist metadata. */
export function formatYouTubeChartTrackDescription(artist: string): string {
    return `Трек чарта · ${artist}`;
}

/** Russian playlist track count. */
export function formatYouTubePlaylistTrackCount(count: number): string {
    return `${count} ${pluralRu(count, ["трек", "трека", "треков"])}`;
}

/** Human-readable total duration for a YouTube Music collection. */
export function formatYouTubePlaylistDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    if (hours > 0) return `около ${hours} ч ${minutes} мин`;
    return `${minutes} мин`;
}

/** Toast after adding a provider queue in display order. */
export function formatYouTubeTracksAdded(count: number): string {
    const verb =
        count % 10 === 1 && count % 100 !== 11 ? "Добавлен" : "Добавлено";
    return `${verb} в очередь ${formatYouTubePlaylistTrackCount(count)}`;
}

/** Toast after copying a provider collection into a playlist. */
export function formatYouTubeTracksAddedToPlaylist(count: number): string {
    return `Добавлено в плейлист: ${formatYouTubePlaylistTrackCount(count)}`;
}

/** Compact listener count for artist search cards. */
export function formatSearchArtistListeners(count: number | undefined): string {
    if (!count) return searchExtrasRu.artist.type;
    if (count >= 1_000_000) {
        return `${(count / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн слушателей`;
    }
    if (count >= 1_000) {
        return `${(count / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: count >= 10_000 ? 0 : 1 })} тыс. слушателей`;
    }
    return `${count.toLocaleString("ru-RU")} ${pluralRu(count, ["слушатель", "слушателя", "слушателей"])}`;
}
