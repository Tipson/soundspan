import type { TrackPreferenceSignal } from "@/lib/api";
import { pluralRu } from "./ru";

/** Russian copy for the initial server setup surface. */
export const onboardingRu = {
    loading: "Загрузка…",
    welcome: "Добро пожаловать на вашу личную музыкальную платформу",
    stepAccount: "Аккаунт",
    stepIntegrations: "Интеграции",
    stepEnrichment: "Обогащение",
    createAccount: "Создайте аккаунт",
    createAccountDescription:
        "Настройте аккаунт для своей личной музыкальной коллекции",
    username: "Имя пользователя",
    usernamePlaceholder: "Выберите имя пользователя",
    password: "Пароль",
    passwordPlaceholder: "Не менее 6 символов",
    confirmPassword: "Подтвердите пароль",
    confirmPasswordPlaceholder: "Введите пароль ещё раз",
    creatingAccount: "Создаём аккаунт…",
    continue: "Продолжить",
    passwordMismatch: "Пароли не совпадают",
    passwordTooShort: "Пароль должен содержать не менее 6 символов",
    usernameTaken:
        "Это имя пользователя уже занято. Если это ваш аккаунт, обновите страницу и продолжите настройку.",
    accountCreationFailed: "Не удалось создать аккаунт",
    connectServices: "Подключите сервисы",
    connectServicesDescription:
        "Необязательные интеграции для расширения музыкальной коллекции",
    lidarr: "Lidarr",
    lidarrDescription: "Автоматическое управление музыкальной коллекцией",
    audiobookshelf: "Audiobookshelf",
    audiobookshelfDescription: "Управление коллекцией аудиокниг",
    soulseek: "Soulseek",
    soulseekDescription: "Поиск музыки в одноранговой сети",
    skipForNow: "Пропустить",
    saving: "Сохраняем…",
    configurationSaveFailed: "Не удалось сохранить настройки",
    urlApiRequired: "Укажите URL и ключ API",
    soulseekCredentialsRequired: "Укажите имя пользователя и пароль",
    analysisFeatures: "Возможности анализа",
    analysisFeaturesDescription: "Обнаруженные средства аудиоанализа",
    detectedAnalysisFeatures: "Обнаруженные средства анализа",
    detectingFeatures: "Проверяем доступные возможности…",
    musicCnnTitle: "Аудиоанализ MusicCNN",
    musicCnnDescription:
        "Нейросеть определяет BPM, тональность, настроение, энергичность, танцевальность и другие характеристики музыки.",
    clapTitle: "Vibe-эмбеддинги CLAP",
    clapDescription:
        "Аудиоотпечатки передают общее звучание трека и помогают находить похожую музыку.",
    analysisCapacityLead:
        "Анализ выполняется в фоне и может потреблять более 4 GiB памяти.",
    deploymentGuide: "инструкцию по развёртыванию",
    analysisCapacityTail:
        "для планирования ресурсов на маломощных серверах. Чтобы отключить анализаторы, скопируйте",
    copyTo: "в",
    andRestart: "и перезапустите сервисы.",
    liteModeLead:
        "Сейчас используется облегчённый режим. Чтобы включить анализаторы, удалите",
    restartWith: "и выполните",
    artistEnrichment: "Обогащение данных исполнителей",
    artistEnrichmentDescription:
        "Обогащение автоматически добавляет биографии, качественные изображения, жанры и связи из внешних источников. Эти данные улучшают умные функции и делают коллекцию информативнее.",
    finishingSetup: "Завершаем настройку…",
    completeSetup: "Завершить настройку",
    footerTagline: "Слушайте без ограничений",
    serverUrlPlaceholder: "URL сервера",
    soulseekUsernamePlaceholder: "Имя пользователя Soulseek",
    soulseekPasswordPlaceholder: "Пароль Soulseek",
    soulseekCredentialsHint:
        "Это данные вашей учётной записи сети Soulseek, а не вход в Slskd",
    apiKeyPlaceholder: "Ключ API",
    testConnection: "Проверить подключение",
    createSoulseekAccount: "Создать аккаунт можно на",
} as const satisfies Record<string, string>;

type OnboardingService = "lidarr" | "audiobookshelf" | "soulseek";

function onboardingServiceName(service: OnboardingService): string {
    if (service === "lidarr") return onboardingRu.lidarr;
    if (service === "audiobookshelf") return onboardingRu.audiobookshelf;
    return onboardingRu.soulseek;
}

/** User-facing success after checking an optional setup integration. */
export function formatOnboardingConnectionSuccess(
    service: OnboardingService,
): string {
    return `${onboardingServiceName(service)} подключён`;
}

/** User-facing failure after checking an optional setup integration. */
export function formatOnboardingConnectionFailure(
    service: OnboardingService,
): string {
    return `Не удалось подключиться к ${onboardingServiceName(service)}`;
}

/** Russian copy for the playback queue surface. */
export const queueRu = {
    title: "Очередь",
    sharedTitle: "Общая очередь",
    cleared: "Очередь очищена",
    sharedCleared: "Общая очередь очищена",
    removed: "Удалено из очереди",
    peerOffline: "Этот сервер сейчас не в сети",
    unavailableInSession:
        "Трек недоступен вашему аккаунту в этом совместном прослушивании",
    hostOnly: "Текущий трек может менять только организатор",
    playingFromQueue: "Воспроизводим из очереди",
    saveFailed: "Не удалось сохранить плейлист",
    saveAsPlaylist: "Сохранить как плейлист",
    clearQueue: "Очистить очередь",
    emptyTitle: "В очереди пока нет треков",
    emptyDescription:
        "Начните слушать музыку, и следующие треки появятся здесь",
    browseLibrary: "Открыть коллекцию",
    nowPlaying: "Сейчас играет",
    unavailable: "Недоступно",
    nextUp: "Далее",
    previouslyPlayed: "Прослушано ранее",
    saveDialogTitle: "Сохранить очередь как плейлист",
    cancel: "Отмена",
    saving: "Сохраняем…",
    save: "Сохранить",
    dragToReorder: "Перетащить для изменения порядка",
    podcastEpisode: "Эпизод подкаста",
    playNow: "Воспроизвести сейчас",
    removeFromQueue: "Удалить из очереди",
    moveUp: "Переместить выше",
    moveDown: "Переместить ниже",
} as const satisfies Record<string, string>;

/** Queue item count with Russian plural forms. */
export function formatQueueCount(count: number): string {
    return `${count} ${pluralRu(count, ["элемент", "элемента", "элементов"])} в очереди`;
}

/** Description in the queue-to-playlist dialog. */
export function formatQueueSaveDescription(count: number): string {
    return `Сохранить ${count} ${pluralRu(count, ["трек", "трека", "треков"])} в новом плейлисте`;
}

/** Success after saving the current queue to a playlist. */
export function formatQueueSaved(count: number, name: string): string {
    return `${count} ${pluralRu(count, ["трек", "трека", "треков"])} сохранено в плейлист «${name}»`;
}

/** Russian copy for artist details and artist-wide actions. */
export const artistRu = {
    fallbackName: "Исполнитель",
    playAlbumFailed: "Не удалось воспроизвести альбом",
    noPlayableTracks: "У этого исполнителя не найдено доступных треков",
    radioStarting: "Запускаем радио исполнителя…",
    radioNotEnough:
        "В коллекции пока недостаточно похожей музыки для радио исполнителя",
    radioStartFailed: "Не удалось запустить радио исполнителя",
    radioCancelled: "Радио исполнителя отменено",
    loading: "Загружаем исполнителя…",
    notFound: "Исполнитель не найден",
    notFoundDescription: "Этого исполнителя пока нет в вашей коллекции.",
    goBack: "Назад",
    popular: "Популярные треки",
    noTracks: "Нет доступных треков",
    noTracksDescription:
        "Подключённые музыкальные источники не вернули доступные треки этого исполнителя.",
    loadingTracks: "Загружаем треки…",
    noSingles: "Нет доступных синглов или EP",
    noAlbums: "Нет доступных альбомов",
    noReleasesDescription:
        "Подключённые музыкальные источники не нашли релизы для этого раздела.",
    singlesAndEps: "Синглы и EP",
    discography: "Дискография",
    albums: "Альбомы",
    albumsAvailable: "Доступные альбомы",
    fansAlsoLike: "Похожие исполнители",
    addingTracks: "Добавляем треки…",
    sharedQueueTitle: "Добавить в общую очередь?",
    continue: "Продолжить",
    cancel: "Отмена",
    unknownAlbum: "Неизвестный альбом",
    noLocalTracksToAdd: "Нет локальных треков для добавления",
    addQueueFailed: "Не удалось добавить треки в очередь",
    noLocalTracksToLike: "Нет локальных треков, которые можно отметить",
    likeAllFailed: "Не удалось отметить все треки",
    noLocalTracksForPlaylist: "Нет локальных треков для добавления",
    addPlaylistFailed: "Не удалось добавить треки в плейлист",
    noArtistSelected: "Исполнитель не выбран",
    artistMbidUnavailable: "MBID исполнителя недоступен",
    downloadArtistFailed: "Не удалось начать загрузку исполнителя",
    albumMbidUnavailable: "MBID альбома недоступен",
    downloadAlbumFailed: "Не удалось начать загрузку альбома",
} as const satisfies Record<string, string>;

/** Artist album playback success while preserving catalog metadata. */
export function formatArtistAlbumPlaying(albumTitle: string): string {
    return `Воспроизводим «${albumTitle}»`;
}

/** Artist radio success while preserving the artist name. */
export function formatArtistRadioPlaying(
    artistName: string,
    count: number,
): string {
    return `Играет радио «${artistName}» · ${count} ${pluralRu(count, ["трек", "трека", "треков"])}`;
}

/** Count-aware prompt before adding artist radio to a shared queue. */
export function formatArtistSharedRadioMessage(count: number): string {
    return `Вы слушаете вместе. Радио исполнителя добавит ${count} ${pluralRu(count, ["трек", "трека", "треков"])} в общую очередь. Продолжить?`;
}

/** Pagination label for locally indexed artist tracks. */
export function formatArtistLoadMoreTracks(
    loaded: number,
    total: number,
): string {
    return `Показать ещё треки (${loaded} из ${total})`;
}

/** Pagination label while scanning provider releases for artist tracks. */
export function formatArtistProviderLoadMoreTracks(
    loadedReleases: number,
    totalReleases: number,
): string {
    return `Показать ещё треки (проверено релизов: ${loadedReleases} из ${totalReleases})`;
}

/** Bulk artist-like result. */
export function formatArtistLikedTracks(count: number): string {
    return `Отмечено как понравившиеся: ${count} ${pluralRu(count, ["трек", "трека", "треков"])}`;
}

/** Partial artist-to-playlist result. */
export function formatArtistPlaylistPartial(
    added: number,
    failed: number,
): string {
    return `Добавлено треков: ${added}; не удалось добавить: ${failed}`;
}

/** Successful artist-to-playlist result. */
export function formatArtistPlaylistAdded(count: number): string {
    return `Добавлено в плейлист: ${count} ${pluralRu(count, ["трек", "трека", "треков"])}`;
}

/** Artist acquisition copy while preserving catalog metadata. */
export function formatArtistDownloadAlreadyQueued(name: string): string {
    return `Недостающие альбомы исполнителя «${name}» уже добавляются в очередь`;
}

export function formatArtistDiscographyCheck(name: string): string {
    return `Проверяем дискографию «${name}»…`;
}

export function formatArtistAlbumsQueued(name: string): string {
    return `Недостающие альбомы исполнителя «${name}» добавлены в очередь`;
}

export function formatAlbumDownloadAlreadyQueued(title: string): string {
    return `Альбом «${title}» уже загружается`;
}

export function formatAlbumDownloadPreparing(title: string): string {
    return `Подготавливаем загрузку «${title}»…`;
}

export function formatAlbumDownloading(title: string): string {
    return `Загружаем «${title}»`;
}

/** Russian copy for album details and album-wide actions. */
export const albumRu = {
    loading: "Загружаем альбом…",
    loadErrorTitle: "Не удалось загрузить альбом",
    notFound: "Альбом не найден",
    backToAlbums: "Вернуться к альбомам",
    deleted: "Альбом удалён",
    deleteFailed: "Не удалось удалить альбом. Попробуйте ещё раз.",
    deleteTitle: "Удалить альбом с сервера?",
    deleteMessage:
        "Альбом и его аудиофайлы будут безвозвратно удалены из серверной коллекции. Это действие нельзя отменить.",
    deleting: "Удаляем…",
    deleteAlbum: "Удалить альбом",
    dataUnavailable: "Данные альбома недоступны",
    mbidUnavailable: "MBID альбома недоступен",
    downloadStartFailed: "Не удалось начать загрузку альбома",
    alreadyDownloading: "Альбом уже загружается",
    noTracksToAdd: "Нет доступных треков для добавления",
    noTracksForPreference: "В альбоме нет треков для оценки",
    preferenceUpdateFailed: "Не удалось обновить оценки треков альбома",
    loadFailed: "Не удалось загрузить альбом",
} as const satisfies Record<string, string>;

/** Album-wide preference result with Russian plural forms. */
export function formatAlbumPreferenceSuccess(
    signal: TrackPreferenceSignal,
    trackCount: number,
): string {
    const count = `${trackCount} ${pluralRu(trackCount, ["трек", "трека", "треков"])}`;
    if (signal === "thumbs_up") {
        return `Отмечено как понравившиеся: ${count} из альбома`;
    }
    if (signal === "thumbs_down") {
        return `Отмечено как не понравившиеся: ${count} из альбома`;
    }
    return `Оценки очищены: ${count} из альбома`;
}

/** Russian copy for generated mix details. */
export const mixRu = {
    title: "Микс",
    unavailable: "Функция недоступна",
    disabled: "Автоматические миксы отключены на этом сервере.",
    saveSuccess: "Микс сохранён как плейлист",
    alreadySaved: "Этот микс уже сохранён как плейлист.",
    saveFailed: "Не удалось сохранить микс как плейлист",
    notFound: "Микс не найден",
    shuffle: "Перемешать",
    saving: "Сохраняем…",
    saveAsPlaylist: "Сохранить как плейлист",
    tableTitle: "Название",
    tableAlbum: "Альбом",
    tableDuration: "Длительность",
    inQueue: "В очереди",
    addToQueue: "Добавить в очередь",
    noTracks: "Нет треков",
    empty: "Этот микс пуст",
} as const satisfies Record<string, string>;

/** Human-readable total duration for a generated mix. */
export function formatMixDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `около ${hours} ч ${minutes} мин`;
    return `${minutes} мин`;
}

/** Generated mix track count with Russian plural forms. */
export function formatMixTrackCount(count: number): string {
    return `${count} ${pluralRu(count, ["трек", "трека", "треков"])}`;
}
