import { pluralRu } from "./ru";

/** Russian copy for secondary search and YouTube Music discovery surfaces. */
export const searchExtrasRu = {
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
    },
    tvSearch: {
        label: "Поиск музыки",
        placeholder: "Нажмите Enter, чтобы найти…",
        hint: "Нажмите Enter для поиска",
    },
    artist: {
        type: "Исполнитель",
    },
} as const;

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
