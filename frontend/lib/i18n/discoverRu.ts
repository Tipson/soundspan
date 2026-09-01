import { pluralRu } from "./ru";

/** Russian product copy for the weekly discovery playlist. */
export const discoverRu = {
    name: "Открытия недели",
    type: "Плейлист",
    description:
        "Персональный плейлист с новой музыкой на основе вашей истории прослушиваний.",
    weekOf: "Неделя с",
    updated: "Обновлено",
    sourceMix: "Источники",
    local: "на устройстве",
    gapFill: "дополнение",
    unavailableTitle: "Функция недоступна",
    unavailableHint: "Подбор на этом сервере отключён.",
    action: {
        pause: "Пауза",
        playAll: "Воспроизвести всё",
        shuffleAll: "Перемешать всё",
        addAllToQueue: "Добавить всё в очередь",
        addAllToPlaylist: "Добавить всё в плейлист",
        regenerate: "Собрать заново",
        generate: "Собрать",
        generateNow: "Собрать сейчас",
        generating: "Собираем…",
        settings: "Настройки",
    },
    status: {
        finalizing: "Завершаем подбор…",
        refreshing: "Обновляем рекомендации…",
        progress: "Готово",
        starting: "Начинаем…",
        working: "Обрабатываем…",
        finishingList: "Завершаем список треков на эту неделю.",
        loadingLatest: "Загружаем свежие «Открытия недели»",
        loadingLatestHint:
            "Плейлист уже собран, но на его полную загрузку может потребоваться ещё несколько секунд.",
        emptyTitle: "«Открытий недели» пока нет",
        emptyHint:
            "Соберите первый плейлист на основе вашей истории прослушиваний.",
    },
    toast: {
        generationInProgress: "Плейлист уже собирается…",
        generating: "Собираем «Открытия недели»…",
        generationStarted: "Сборка началась. Обновляем рекомендации…",
        generationFailed: "Не удалось собрать плейлист",
        previewLoadFailed: "Не удалось загрузить фрагмент",
        previewPlayFailed: "Не удалось воспроизвести фрагмент",
        previewUnavailable: "Для этого альбома нет фрагмента",
        settingSaveFailed: "Не удалось сохранить настройку",
        nothingToClear: "Нет рекомендаций для удаления",
        clearFailed: "Не удалось очистить плейлист",
        addFailed: "Не все треки удалось добавить в плейлист",
        adding: "Добавляем треки…",
    },
    settings: {
        title: "Настройки",
        playlistSize: "Размер плейлиста",
        sizeHint:
            "Сначала используются ваши прослушивания и коллекция. Чем больше плейлист, тем разнообразнее подбор.",
        albumExclusion: "Не повторять альбомы",
        disabled: "Выключено",
        exclusionHint:
            "Через сколько месяцев можно снова рекомендовать тот же альбом. Выберите 0, чтобы отключить ограничение.",
        clear: "Очистить плейлист",
        clearHint:
            "Удалить текущие рекомендации на эту неделю. Ваша коллекция не изменится.",
        clearing: "Очищаем…",
        remove: "Удалить плейлист",
        confirmTitle: "Очистить «Открытия недели»?",
        confirmMessage:
            "Текущие рекомендации будут удалены. Коллекция и аккаунты музыкальных сервисов не изменятся. Отменить действие нельзя.",
        confirm: "Очистить",
        cancel: "Отмена",
    },
    unavailable: {
        description:
            "Эти альбомы были в рекомендациях, но не нашлись в подключённых источниках. Можно послушать 30-секундные фрагменты.",
        original: "Исходная рекомендация",
        replacement: "Замена",
        preview: "30 с",
    },
    tiers: {
        high: "Точное совпадение",
        medium: "Хорошее совпадение",
        explore: "Новое",
        wildcard: "Сюрприз",
    },
    source: {
        loading: "Ищем",
        preview: "Фрагмент",
        local: "Локально",
    },
    columns: {
        title: "Название",
        album: "Альбом",
        match: "Совпадение",
        source: "Источник",
    },
    howItWorks: {
        title: "Как это работает",
        history:
            "Сначала учитываются ваша история прослушиваний и локальная коллекция.",
        variety: "Уровни схожести сочетают знакомые треки и новые находки.",
        providers:
            "Если подключены TIDAL или YouTube Music, часть треков может воспроизводиться из этих сервисов.",
        badges: "Метки показывают, где доступен трек: локально, в TIDAL или YouTube Music.",
        repeats: "Альбомы не повторяются в течение 6 месяцев.",
        noWrites:
            "Этот сценарий не скачивает треки и не изменяет коллекцию автоматически.",
    },
} as const;

export function discoverTrackCount(count: number): string {
    return `${count} ${pluralRu(count, ["трек", "трека", "треков"])}`;
}

export function discoverAlbumCount(count: number): string {
    return `${count} ${pluralRu(count, ["альбом недоступен", "альбома недоступны", "альбомов недоступны"])}`;
}

export function discoverMonthCount(count: number): string {
    return `${count} ${pluralRu(count, ["месяц", "месяца", "месяцев"])}`;
}

export function discoverQueuedCount(count: number): string {
    return `${discoverTrackCount(count)} ${pluralRu(count, ["добавлен", "добавлено", "добавлено"])} в очередь`;
}

export function discoverRemovedCount(count: number): string {
    return `${count} ${pluralRu(count, ["рекомендация удалена", "рекомендации удалены", "рекомендаций удалено"])}`;
}

export function discoverAddedCount(count: number): string {
    return `${discoverTrackCount(count)} ${pluralRu(count, ["добавлен", "добавлено", "добавлено"])} в плейлист`;
}

export function formatDiscoverDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `около ${hours} ч ${minutes} мин`;
    }
    return `${minutes} мин`;
}

export function formatDiscoverDate(
    value: string | Date,
    withYear = false,
): string {
    return new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "short",
        ...(withYear ? { year: "numeric" as const } : {}),
    }).format(new Date(value));
}
