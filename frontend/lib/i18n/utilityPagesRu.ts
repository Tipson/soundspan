import type { ImportResolutionSource } from "@/lib/api";
import { pluralRu } from "./ru";

/** Russian copy for the playlist import surface. */
export const importPageRu = {
    noProviderMatch: "Совпадение у провайдеров не найдено",
    resolved: "Найдено совпадение",
    confidence: "Уверенность",
    localBadge: "ЛОКАЛЬНО",
    unresolvedBadge: "НЕ НАЙДЕНО",
    noTracks: "В этом плейлисте нет треков.",
    fileReadFailed: "Не удалось прочитать файл",
    selectM3uFirst: "Сначала выберите файл M3U",
    previewM3uFailed: "Не удалось подготовить предпросмотр файла M3U",
    importFailed: "Не удалось импортировать плейлист",
    supportedUrls:
        "Поддерживаются ссылки на плейлисты Spotify, Deezer, YouTube Music и TIDAL",
    alreadyInProgress: "Импорт этого плейлиста уже выполняется",
    jobSubmitted:
        "Импорт запущен. Ход выполнения доступен во вкладке импорта в панели активности.",
    submitFailed: "Не удалось запустить импорт",
    back: "Назад",
    urlPlaceholder:
        "Вставьте ссылку на плейлист Spotify, Deezer, YouTube Music или TIDAL",
    urlHint:
        "Вставьте ссылку на плейлист из Spotify, Deezer, YouTube Music или TIDAL.",
    spotifyBoundary:
        "Spotify используется только для чтения списка треков из публичного плейлиста. Soundspan не воспроизводит музыку из Spotify, не изменяет исходный плейлист и не сохраняет аудиофайлы на сервере. Приватные плейлисты пока не поддерживаются.",
    m3uMatchHint:
        "Треки сопоставляются с локальной коллекцией по путям к файлам и метаданным.",
    localSummary: "Локально",
} as const satisfies Record<string, string>;

/** User-facing provider match status for an imported track. */
export function formatImportResolutionSubtitle(track: {
    source: ImportResolutionSource;
    confidence: number;
}): string {
    if (track.source === "unresolved") return importPageRu.noProviderMatch;
    if (track.confidence > 0) {
        return `${importPageRu.confidence}: ${track.confidence}%`;
    }
    return importPageRu.resolved;
}

/** Number of tracks discovered in an import source. */
export function formatImportSongsFound(count: number): string {
    const verb = count % 10 === 1 && count % 100 !== 11 ? "Найден" : "Найдено";
    return `${verb} ${count} ${pluralRu(count, ["трек", "трека", "треков"])}`;
}

/** Number of unresolved tracks skipped during import. */
export function formatImportSkipped(count: number): string {
    return `Пропущено: ${count} ${pluralRu(count, ["трек", "трека", "треков"])} без совпадения`;
}

/** Russian copy for public shared music links. */
export const shareRu = {
    loading: "Открываем общую ссылку…",
    unavailableTitle: "Ссылка недоступна",
    unavailableDescription:
        "Ссылка недействительна, истекла или её владелец закрыл доступ.",
    sharedTrack: "Трек по ссылке",
    sharedAlbum: "Альбом по ссылке",
    sharedPlaylist: "Плейлист по ссылке",
    coverAlt: "Обложка",
    unknownUser: "Неизвестный пользователь",
    upNext: "Далее",
    downloadAll: "Скачать всё",
    download: "Скачать",
    playing: "Играет",
    downloadTrack: "Скачать трек",
    playbackProgress: "Позиция воспроизведения",
    previous: "Предыдущий трек",
    pause: "Пауза",
    play: "Воспроизвести",
    next: "Следующий трек",
    unmute: "Включить звук",
    mute: "Выключить звук",
    volume: "Громкость",
} as const satisfies Record<string, string>;

export function formatShareOwner(username: string | undefined): string {
    return `Автор: ${username || shareRu.unknownUser}`;
}

export function formatShareCount(
    count: number,
    kind: "playlist" | "tracks",
): string {
    const forms =
        kind === "playlist"
            ? (["элемент", "элемента", "элементов"] as const)
            : (["трек", "трека", "треков"] as const);
    return `${count} ${pluralRu(count, forms)}`;
}

/** Russian copy for first library synchronization. */
export const syncRu = {
    scanningLibrary: "Сканируем музыкальную коллекцию…",
    syncingAudiobooks: "Синхронизируем аудиокниги…",
    redirecting: "Готово. Открываем Soundspan…",
    scanFailed:
        "Не удалось просканировать коллекцию. Этот шаг можно пропустить и повторить позже.",
    discoveringTracks: "Ищем треки…",
    indexingAlbums: "Индексируем альбомы…",
    organizingArtists: "Собираем исполнителей…",
    almostDone: "Почти готово…",
    startFailed:
        "Не удалось запустить синхронизацию. Этот шаг можно пропустить и повторить позже вручную.",
    settingUp: "Завершаем настройку",
    ready: "Всё готово",
    complete: "завершено",
    stepTracks: "Сканируем треки",
    stepLibrary: "Собираем коллекцию",
    stepAlbums: "Упорядочиваем альбомы",
    stepIndexes: "Создаём индексы",
    skip: "Пропустить →",
    largeLibraryHint:
        "Большая коллекция может синхронизироваться несколько минут.",
} as const satisfies Record<string, string>;

/** Russian copy for library-generated radio stations. */
export const radioRu = {
    allName: "Перемешать всё",
    allDescription: "Вся ваша коллекция",
    workoutName: "Тренировка",
    workoutDescription: "Энергичные треки",
    discoveryName: "Открытия",
    discoveryDescription: "Редко звучавшие находки",
    favoritesName: "Любимое",
    favoritesDescription: "Самые прослушиваемые треки",
    title: "Радиостанции",
    subtitle: "Станции из вашей музыкальной коллекции",
    quickStart: "Быстрый старт",
    quickStartDescription: "Выберите готовую станцию из своей коллекции",
    byGenre: "По жанрам",
    byGenreDescription: "Перемешайте треки выбранного жанра",
    byDecade: "По десятилетиям",
    byDecadeDescription: "Путешествуйте по музыкальным эпохам",
    aboutTitle: "О радиостанциях",
    aboutDescription:
        "Станции создаются из вашей музыкальной коллекции. При открытии формируется плейлист, который можно воспроизвести снова, обновить или дополнить треками. «Перемешать всё» сразу запускает всю коллекцию. По мере добавления музыки здесь автоматически появляются новые станции по жанрам и десятилетиям.",
    openFailed: "Не удалось открыть радиостанцию",
} as const satisfies Record<string, string>;

export function formatRadioTrackCount(count: number): string {
    return `${count} ${pluralRu(count, ["трек", "трека", "треков"])}`;
}

export function formatRadioStationStarted(
    name: string,
    trackCount: number,
): { title: string; description: string } {
    return {
        title: `Радио «${name}»`,
        description: `Перемешиваем ${formatRadioTrackCount(trackCount)}`,
    };
}

export function formatRadioNoTracks(name: string): string {
    return `Для радиостанции «${name}» треки не найдены`;
}

export function formatRadioNotEnoughTracks(name: string): string {
    return `Недостаточно треков для радиостанции «${name}»`;
}

export function formatRadioMinimumDescription(
    found: number,
    minimum: number,
): string {
    return `Найдено ${found}, требуется не менее ${minimum}`;
}

export function formatRadioDecadeDescription(
    decade: number,
    count: number,
): string {
    return `${decade}–${decade + 9} • ${formatRadioTrackCount(count)}`;
}
