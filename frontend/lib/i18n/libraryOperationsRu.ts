import type {
    MusicRequestFilter,
    MusicRequestStatus,
} from "@/lib/musicRequests";
import { pluralRu } from "./ru";

export const libraryOperationsRu = {
    libraryInsights: {
        title: "Аналитика коллекции",
        description:
            "Состояние метаданных, анализа, дубликатов и хранилища. Сводка обновляется каждые 15 минут.",
        recompute: "Пересчитать",
        recomputeAria: "Пересчитать аналитику коллекции",
        loading: "Загружаем аналитику коллекции…",
        loadFailed: "Не удалось загрузить аналитику коллекции",
        refreshFailed: "Не удалось обновить аналитику коллекции",
        retry: "Повторить",
        truncated: "(для большой коллекции показана выборка)",
        metadata: {
            title: "Пробелы в метаданных",
            tabs: {
                art: "Обложки",
                mbid: "Идентификаторы MusicBrainz",
                genres: "Жанры",
                lyrics: "Тексты",
            },
            loadFailed: "Не удалось загрузить пробелы в метаданных",
            empty: "В этой категории всё заполнено.",
            remediation:
                "Исправьте это в разделе «Кэш и автоматизация»: обогащение метаданных добавляет обложки, MBID и жанры, а тексты загружаются во время обработки.",
            covered: "Все данные заполнены.",
        },
        analysis: {
            title: "Покрытие анализа",
            loadFailed: "Не удалось загрузить данные анализа",
            actionFailed:
                "Не удалось выполнить действие. Подробности доступны в журналах сервера.",
            retryAudio: "Повторить неудачный анализ аудио",
            retryVibe: "Повторить неудачный анализ Vibe",
            audioQueued: "Неудачный анализ аудио поставлен в очередь заново.",
            vibeQueued: "Неудачный анализ Vibe поставлен в очередь заново.",
            itemError: "Ошибка анализа",
            empty: "Треков с ошибками нет. Ожидающие треки обрабатываются автоматически.",
        },
        duplicates: {
            title: "Дубликаты и версии",
            loadFailed: "Не удалось загрузить группы дубликатов",
            reportOnly:
                "Это только отчёт: ничего не скрывается, не объединяется и не удаляется. Файлы остаются без изменений.",
            empty: "Группы дубликатов не найдены.",
            tiers: {
                audioHash: "Точный дубликат аудио",
                recordingMbid: "Одинаковая запись",
                isrc: "Одинаковый ISRC",
            },
        },
        storage: {
            title: "Хранилище",
            loadFailed: "Не удалось загрузить отчёт о хранилище",
            byFormat: "По форматам",
            unknownFormat: "Неизвестный формат",
            largestArtists: "Исполнители с наибольшим объёмом",
        },
        quality: {
            title: "Отклонения качества",
            loadFailed: "Не удалось загрузить отклонения качества",
            bitrateFloor: "Порог битрейта:",
            empty: "Ниже этого порога нет альбомов с потерями.",
        },
    },
    releases: {
        title: "Радар релизов",
        heading: "Новинки и будущие релизы",
        loadFailed: "Не удалось загрузить релизы",
        actionFailed: "Не удалось выполнить действие с релизом",
        comingSoon: "Скоро",
        justDropped: "Свежие релизы",
        emptyTitle: "Релизы не найдены",
        emptyDescription:
            "Добавьте исполнителей в Lidarr и включите отслеживание, чтобы видеть здесь будущие и недавние релизы.",
        configureLidarr: "Настроить Lidarr",
        inLibrary: "В коллекции",
        available: "Доступно",
        alreadyRequested: "Уже запрошено",
        downloadRelease: "Загрузить этот релиз",
        requestRelease: "Запросить этот релиз",
    },
    requests: {
        title: "Запросы",
        myTitle: "Мои запросы",
        adminSubtitle:
            "Просматривайте запросы пользователей на альбомы и принимайте решение.",
        userSubtitle: "Альбомы, которые вы попросили добавить в коллекцию.",
        filterAria: "Фильтр запросов по статусу",
        approve: "Одобрить",
        decline: "Отклонить",
        cancel: "Отменить",
        requestedBy: "Запросил",
        declinedReason: "Причина отказа:",
        filteredEmpty: "Нет запросов с выбранным статусом.",
        adminEmpty:
            "Запросов пока нет. Новые запросы пользователей на альбомы появятся здесь.",
        userEmpty:
            "Вы пока ничего не запросили. Найдите отсутствующий в коллекции альбом и нажмите «Запросить».",
        browseLibrary: "Открыть коллекцию",
        actionFailed: "Не удалось выполнить действие",
        approveLoading: "Одобряем запрос…",
        approveSuccess: "Запрос одобрен — загрузка началась",
        declineLoading: "Отклоняем запрос…",
        declineSuccess: "Запрос отклонён",
        cancelLoading: "Отменяем запрос…",
        cancelSuccess: "Запрос отменён",
        unknownStatus: "Неизвестный статус",
    },
} as const;

const countRu = (
    count: number,
    forms: readonly [one: string, few: string, many: string],
) => `${count} ${pluralRu(count, forms)}`;

export function formatMetadataGapsSummaryRu(
    missingArt: number,
    missingMbid: number,
    missingGenres: number,
    missingLyrics: number,
): string {
    return [
        `${countRu(missingArt, ["альбом", "альбома", "альбомов"])} без обложки`,
        `${countRu(missingMbid, ["альбом", "альбома", "альбомов"])} без MBID`,
        `${countRu(missingGenres, ["трек", "трека", "треков"])} без жанров`,
        `${countRu(missingLyrics, ["трек", "трека", "треков"])} без текста`,
    ].join(" · ");
}

export function formatAnalysisCoverageSummaryRu(
    audio: string,
    vibe: string,
    loudness: string,
    failed: number,
): string {
    return `Аудио ${audio} · Vibe ${vibe} · Громкость ${loudness} · ${countRu(failed, ["ошибка", "ошибки", "ошибок"])}`;
}

export function formatDuplicatesSummaryRu(
    clusters: number,
    exact: number,
    sameRecording: number,
    sameIsrc: number,
): string {
    return [
        countRu(clusters, ["группа", "группы", "групп"]),
        `${countRu(exact, ["точное совпадение", "точных совпадения", "точных совпадений"])}`,
        `${countRu(sameRecording, ["одинаковая запись", "одинаковые записи", "одинаковых записей"])}`,
        `${countRu(sameIsrc, ["совпадение ISRC", "совпадения ISRC", "совпадений ISRC"])}`,
    ].join(" · ");
}

export function formatStorageSummaryRu(
    tracks: number,
    size: string,
    formats: number,
): string {
    return `${countRu(tracks, ["трек", "трека", "треков"])} · ${size} · ${countRu(formats, ["формат", "формата", "форматов"])}`;
}

export function formatQualitySummaryRu(albums: number, floorKbps: number) {
    return `${countRu(albums, ["альбом", "альбома", "альбомов"])} с потерями ниже ${floorKbps} kbps`;
}

export function formatTrackCountRu(count: number): string {
    return countRu(count, ["трек", "трека", "треков"]);
}

export function formatShowingRu(
    visible: number,
    total: number,
    forms: readonly [one: string, few: string, many: string],
): string {
    return `Показано ${visible} из ${total} ${pluralRu(total, forms)}.`;
}

export function formatReleaseRadarSummaryRu(
    monitored: number,
    upcoming: number,
    recent: number,
): string {
    return [
        countRu(monitored, [
            "отслеживаемый исполнитель",
            "отслеживаемых исполнителя",
            "отслеживаемых исполнителей",
        ]),
        countRu(upcoming, [
            "будущий релиз",
            "будущих релиза",
            "будущих релизов",
        ]),
        countRu(recent, [
            "недавний релиз",
            "недавних релиза",
            "недавних релизов",
        ]),
    ].join(" • ");
}

export function formatDownloadingReleaseRu(title: string): string {
    return `Загружаем «${title}»…`;
}

export function formatDownloadStartedRu(title: string): string {
    return `Загрузка «${title}» началась`;
}

export function formatRequestingReleaseRu(title: string): string {
    return `Отправляем запрос на «${title}»…`;
}

export function formatReleaseRequestedRu(title: string): string {
    return `Релиз «${title}» запрошен — администратор рассмотрит запрос`;
}

export function formatRelativeReleaseDateRu(
    dateInput: string | number | Date,
    nowInput: string | number | Date = new Date(),
): string {
    const date = new Date(dateInput);
    const now = new Date(nowInput);
    const diffDays = Math.ceil(
        (date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (diffDays === 0) return "Сегодня";
    if (diffDays === 1) return "Завтра";
    if (diffDays === -1) return "Вчера";
    if (diffDays > 1 && diffDays <= 7) {
        return `Через ${countRu(diffDays, ["день", "дня", "дней"])}`;
    }
    if (diffDays < -1 && diffDays >= -7) {
        const days = Math.abs(diffDays);
        return `${countRu(days, ["день", "дня", "дней"])} назад`;
    }

    return date.toLocaleDateString("ru-RU", {
        month: "short",
        day: "numeric",
        year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
}

export function formatReleaseCalendarDateRu(
    dateInput: string | number | Date,
): string {
    return new Date(dateInput).toLocaleDateString("ru-RU", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

export function formatRequestDateRu(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toLocaleDateString("ru-RU", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

const REQUEST_STATUS_RU: Readonly<Record<MusicRequestStatus, string>> = {
    pending: "Ожидает",
    approved: "Одобрен",
    denied: "Отклонён",
    fulfilled: "В коллекции",
    failed: "Ошибка",
    cancelled: "Отменён",
};

const REQUEST_FILTER_RU: Readonly<Record<MusicRequestFilter, string>> = {
    all: "Все",
    ...REQUEST_STATUS_RU,
};

export function requestStatusLabelRu(status: string): string {
    return status in REQUEST_STATUS_RU
        ? REQUEST_STATUS_RU[status as MusicRequestStatus]
        : libraryOperationsRu.requests.unknownStatus;
}

export function requestFilterLabelRu(filter: MusicRequestFilter): string {
    return REQUEST_FILTER_RU[filter];
}

export function formatPendingRequestsRu(count: number): string {
    return `${count} на рассмотрении`;
}
