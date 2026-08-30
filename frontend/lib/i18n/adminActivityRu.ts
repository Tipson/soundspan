import { pluralRu } from "./ru";

/**
 * Russian copy owned by the administrative and activity surfaces.
 * Provider names, protocol labels and catalog metadata intentionally remain
 * outside this dictionary.
 */
export const adminActivityRu = {
    admin: {
        title: "Администрирование",
        loading: "Загружаем настройки администрирования…",
        loadFailed:
            "Не удалось загрузить настройки с сервера. Редактирование станет доступно после успешной загрузки.",
        retry: "Повторить",
        saved: "Сохранено",
        saveFailed: "Не удалось сохранить",
        saving: "Сохраняем…",
        save: "Сохранить",
        sidebar: {
            playbackSources: "Источники воспроизведения",
            youtubeMusic: "YouTube Music",
            artwork: "Обложки",
            cacheAutomation: "Кэш и автоматизация",
            librarySafety: "Защита серверной медиатеки",
            users: "Пользователи",
            federation: "Федерация",
        },
        common: {
            testing: "Проверяем…",
            connected: "Подключено",
            failed: "Ошибка",
            testConnection: "Проверить подключение",
            apiKey: "Ключ API",
            optional: "необязательно",
        },
        playbackSources: {
            title: "Источники воспроизведения",
            description:
                "Порядок источников, если один трек доступен в нескольких местах.",
            priority: "Приоритет источников",
            priorityDescription:
                "Собственная медиатека всегда используется первой. Это приоритет, а не список подключений: недоступные и отключённые источники пропускаются.",
            library: "Медиатека",
            peers: "Другие серверы",
            default: "по умолчанию",
            custom: "Другой порядок (текущий)",
        },
        artwork: {
            title: "Сервисы обложек",
            description: "Дополняйте медиатеку качественными обложками.",
            enableFanart: "Использовать Fanart.tv",
            fanartDescription:
                "Дополнительные обложки исполнителей и альбомов.",
            fanartPlaceholder: "Введите ключ API Fanart.tv",
            lastfmHint:
                "Last.fm уже настроен с ключом по умолчанию. Собственный ключ повышает лимит запросов.",
            lastfmKey: "Ключ API Last.fm (необязательно)",
            lastfmPlaceholder: "Введите собственный ключ API Last.fm",
        },
        librarySafety: {
            title: "Защита серверной медиатеки",
            description:
                "Постоянное удаление файлов с сервера остаётся заблокированным, пока вы явно его не разрешите.",
            allowDeletion: "Разрешить безвозвратное удаление альбомов",
            allowDeletionDescription:
                "По умолчанию выключено. После включения можно удалять локально сохранённые альбомы; сервер по-прежнему проверяет каждый запрос.",
        },
        youtubeMusic: {
            adminDescription:
                "Управляйте доступностью YouTube Music для всех пользователей.",
            legal: "Интеграция использует неофициальные библиотеки и не связана с Google или YouTube. Публичный поиск, каталог и воспроизведение работают без привязки Google-аккаунта. Привязка необязательна и добавляет доступ к личной медиатеке. Для части контента и функций может потребоваться YouTube Music Premium; доступность зависит от аккаунта и региона. Пользователи обязаны соблюдать Условия использования YouTube.",
            enable: "Включить YouTube Music",
            enableDescription:
                "Разрешить всем пользователям поиск, каталог и воспроизведение YouTube Music.",
            accountLinking: "Привязка аккаунта (необязательно)",
            accountLinkingDescription:
                "Укажите данные Google OAuth, чтобы пользователи могли подключать личные аккаунты YouTube Music. Для публичного поиска, каталога и воспроизведения это не требуется.",
            createHere: "создать в Google Cloud",
            clientIdDescription:
                "Google OAuth Client ID; тип приложения — TVs and Limited Input devices.",
            clientIdPlaceholder: "Введите Client ID",
            clientSecretDescription:
                "Client Secret для этого приложения OAuth.",
            clientSecretPlaceholder: "Введите Client Secret",
            authorizationFailed: "Не удалось войти. Попробуйте ещё раз.",
            connectedSuccess: "Аккаунт YouTube Music подключён.",
            codeExpired: "Код входа истёк. Попробуйте ещё раз.",
            authStartFailed:
                "Не удалось начать вход. Проверьте данные в разделе администрирования.",
            quality: {
                low: "Низкое (64 kbps)",
                medium: "Среднее (128 kbps)",
                high: "Высокое (256 kbps)",
                lossless: "Без потерь (лучшее доступное)",
            },
            disabled: "Интеграция выключена. Обратитесь к администратору.",
            unavailable: "Сервис YouTube Music не запущен.",
            checking: "Проверяем…",
            connected: "Подключено",
            active: "Доступно",
            notConnected: "Не подключено",
            userLegal:
                "Интеграция не связана с Google. Публичный каталог доступен без привязки аккаунта; привязка необязательна и добавляет личную медиатеку. Для части контента может потребоваться YouTube Music Premium. Доступность зависит от аккаунта и региона; соблюдайте Условия использования YouTube.",
            linkHint:
                "Подключите Google-аккаунт, чтобы открыть личную медиатеку (необязательно).",
            signInOpened:
                "Страница входа Google должна была открыться. Если этого не произошло, нажмите ссылку ниже.",
            pasteCode: "Введите этот код на странице Google",
            signInInstruction: "Войдите в Google-аккаунт и нажмите",
            allow: "Разрешить",
            openSignIn: "Открыть страницу входа Google",
            showExplore: "Показывать на главной",
            showExploreDescription:
                "Показывать подборки, чарты и настроения YouTube Music на главной странице.",
            streamingQuality: "Качество воспроизведения",
            streamingQualityDescription: "Качество аудиопотока YouTube Music.",
        },
    },
    activity: {
        title: "Активность",
        close: "Закрыть панель активности",
        toggle: "Открыть или закрыть панель активности",
        aria: "Панель активности",
        tabs: {
            notifications: "Уведомления",
            active: "Активные",
            history: "История",
            imports: "Импорт",
            social: "Сейчас онлайн",
        },
        loading: "Загружаем активность…",
        notifications: {
            unavailable: "Не удалось загрузить уведомления",
            unavailableHint:
                "Проверьте подключение и попробуйте открыть панель снова.",
            empty: "Уведомлений пока нет",
            emptyHint: "Здесь появятся новые события.",
            clearAll: "Очистить все",
            view: "Открыть",
            markRead: "Отметить как прочитанное",
            dismiss: "Удалить уведомление",
        },
        activeDownloads: {
            empty: "Нет активных загрузок",
            emptyHint: "Текущие загрузки появятся здесь.",
            cancelAll: "Отменить все",
            cancelAllTitle: "Отменить все загрузки",
            cancel: "Отменить загрузку",
            active: "Активны",
            justStarted: "только что",
        },
        history: {
            empty: "История загрузок пуста",
            emptyHint: "Завершённые загрузки появятся здесь.",
            clearAll: "Очистить все",
            failed: "Не удалось",
            completed: "Завершено",
            retry: "Повторить загрузку",
            remove: "Удалить из истории",
            genericError: "Загрузка завершилась с ошибкой.",
        },
        imports: {
            empty: "Импортов пока нет",
            emptyHint: "Запустите импорт на странице «Импорт музыки».",
            cancel: "Отменить",
            viewPlaylist: "Открыть плейлист",
            warning: "Предупреждение",
            local: "локально",
            unresolved: "не найдено",
            total: "всего",
            genericError: "Импорт завершился с ошибкой.",
            statuses: {
                pending: "Ожидание",
                resolving: "Ищем совпадения",
                creating_playlist: "Создаём плейлист",
                cancelling: "Отменяем",
                completed: "Завершено",
                failed: "Ошибка",
                cancelled: "Отменено",
            },
        },
        social: {
            unavailable: "Статус друзей недоступен",
            unavailableHint: "Не удалось загрузить данные о присутствии.",
            empty: "Сейчас никого нет онлайн",
            emptyHint:
                "Здесь появятся пользователи, которые делятся своим статусом.",
            live: "В реальном времени",
            onlineUsersAria: "Пользователи онлайн, которые делятся статусом",
            listeningStatus: "Статус прослушивания",
            listenTogether: "Участвует в совместном прослушивании",
            notPlaying: "Сейчас ничего не слушает",
            peerUsersAria: "Пользователи онлайн с федеративных серверов",
            from: "Сервер",
            updated: "обновлено",
            usersOn: "Пользователи на сервере",
            statuses: {
                playing: "Слушает",
                paused: "Пауза",
                idle: "Неактивен",
            },
        },
    },
    downloads: {
        title: "Загрузки",
        active: "Активных",
        empty: "Загрузок нет",
        noRecent: "Недавних загрузок нет",
        more: "ещё",
        clearCompleted: "Очистить завершённые",
        clearing: "Очищаем…",
        close: "Закрыть уведомления о загрузках",
        delete: "Удалить загрузку",
        genericError: "Не удалось завершить загрузку.",
    },
} as const;

const DOWNLOAD_STATUS_LABELS: Readonly<Record<string, string>> = {
    pending: "В очереди",
    queued: "В очереди",
    processing: "Обрабатывается",
    downloading: "Загружается",
    completed: "Завершено",
    failed: "Ошибка",
    exhausted: "Ошибка",
    cancelling: "Отменяется",
    cancelled: "Отменено",
};

const DOWNLOAD_TYPE_LABELS: Readonly<Record<string, string>> = {
    album: "Альбом",
    artist: "Исполнитель",
    track: "Трек",
    playlist: "Плейлист",
};

/** Translate stable download state enums while keeping unknown protocol values intact. */
export function translateDownloadStatus(status: string): string {
    return DOWNLOAD_STATUS_LABELS[status.toLowerCase()] ?? status;
}

/** Translate stable media entity enums without touching catalog metadata. */
export function translateDownloadType(type: string): string {
    return DOWNLOAD_TYPE_LABELS[type.toLowerCase()] ?? type;
}

function providerDisplayName(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === "youtube" || normalized === "youtube music") {
        return "YouTube";
    }
    if (normalized === "tidal") return "TIDAL";
    if (normalized === "soulseek") return "Soulseek";
    if (normalized === "lidarr") return "Lidarr";
    return value.trim();
}

/** Localize product-owned status prose while preserving provider names and counts. */
export function localizeDownloadStatusText(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text) return null;
    const exact: Readonly<Record<string, string>> = {
        Queued: "В очереди",
        Processing: "Обрабатывается",
        Complete: "Завершено",
        "Enumerating discography": "Собираем дискографию",
        "Queue admission failed — retrying":
            "Не удалось добавить в очередь — повторяем",
        "Artist expansion failed — see server logs":
            "Не удалось собрать дискографию — подробности в журнале сервера",
        "No missing albums to download": "Все доступные альбомы уже загружены",
        "No sources available": "Нет доступных источников",
        "Failed to start": "Не удалось запустить",
        "Downloading from YouTube Music...": "Загружаем из YouTube Music…",
    };
    if (exact[text]) return exact[text];

    let match = /^Partial download:\s*(\d+)\/(\d+) tracks$/i.exec(text);
    if (match) return `Частично загружено: ${match[1]}/${match[2]} треков`;
    match = /^Downloading\s+(\d+)\s+tracks\.\.\.$/i.exec(text);
    if (match) return `Загружаем ${match[1]} треков…`;
    match = /^(.+?)\s+not found\s+→\s+(.+)$/i.exec(text);
    if (match) {
        return `${providerDisplayName(match[1])}: ничего не найдено → ${providerDisplayName(match[2])}`;
    }
    match = /^(.+?)\s+unavailable\s+—\s+skipped$/i.exec(text);
    if (match)
        return `${providerDisplayName(match[1])}: недоступен — пропущено`;
    match = /^(.+?)\s+and fallback\s+(.+?)\s+unavailable$/i.exec(text);
    if (match) {
        return `${providerDisplayName(match[1])} и резервный ${providerDisplayName(match[2])} недоступны`;
    }
    match = /^(.+?)\s+failed$/i.exec(text);
    if (match) return `${providerDisplayName(match[1])}: ошибка`;
    match = /^(.+?)\s+#(\d+)$/u.exec(text);
    if (match) return `${providerDisplayName(match[1])} · попытка ${match[2]}`;
    match = /^(.+?)\s+✓\s+(\d+)\/(\d+)\s+tracks(?:\s+\((\d+) failed\))?$/i.exec(
        text,
    );
    if (match) {
        const failed = match[4] ? ` · ошибок: ${match[4]}` : "";
        return `${providerDisplayName(match[1])} ✓ ${match[2]}/${match[3]} треков${failed}`;
    }
    return text;
}

/** Translate stable import lifecycle messages without exposing raw backend prose. */
export function localizeImportJobMessage(
    value: unknown,
    kind: "error" | "warning",
): string {
    if (typeof value !== "string" || !value.trim()) {
        return kind === "warning"
            ? "Импорт завершён с предупреждением."
            : adminActivityRu.activity.imports.genericError;
    }
    const text = value.trim();
    const known: Readonly<Record<string, string>> = {
        "Cancelled by user": "Отменено пользователем.",
        "Cancellation requested after playlist creation completed":
            "Запрос на отмену поступил после создания плейлиста; готовый плейлист сохранён.",
        "Playlist creation completed; recovered import status after a persistence failure":
            "Плейлист создан; статус импорта восстановлен после ошибки сохранения.",
        "Spotify playlist pagination was incomplete":
            "Не удалось загрузить весь плейлист Spotify.",
    };
    return (
        known[text] ??
        (kind === "warning"
            ? "Импорт завершён с предупреждением; готовый плейлист сохранён."
            : adminActivityRu.activity.imports.genericError)
    );
}

/** Compact Russian relative time for activity rows. */
export function formatActivityRelativeTime(
    dateInput: string | number | Date,
    nowMs = Date.now(),
): string {
    const date = new Date(dateInput);
    const timestamp = date.getTime();
    if (!Number.isFinite(timestamp)) return "недавно";
    const diff = Math.max(0, nowMs - timestamp);
    if (diff < 60_000) return "только что";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`;
    return date.toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "short",
        year:
            date.getFullYear() === new Date(nowMs).getFullYear()
                ? undefined
                : "numeric",
    });
}

interface ActivityNotificationInput {
    type: string;
    title: string;
    message?: string;
    metadata?: Record<string, unknown>;
}

export interface LocalizedActivityNotification {
    title: string;
    message?: string;
}

function metadataString(
    metadata: Record<string, unknown> | undefined,
    key: string,
): string | null {
    const value = metadata?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataNumber(
    metadata: Record<string, unknown> | undefined,
    key: string,
): number | null {
    const value = metadata?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function releaseLabel(
    metadata: Record<string, unknown> | undefined,
): string | null {
    const artist = metadataString(metadata, "artistName");
    const album = metadataString(metadata, "albumTitle");
    return artist && album ? `${artist} — ${album}` : (artist ?? album);
}

function localizeSystemNotification(
    notification: ActivityNotificationInput,
): LocalizedActivityNotification {
    const message = notification.message?.trim() ?? "";
    switch (notification.title) {
        case "Enrichment Complete": {
            const counts =
                /Enriched (\d+) artists, (\d+) tracks, (\d+) audio analyses/i.exec(
                    message,
                );
            return {
                title: "Обогащение медиатеки завершено",
                message: counts
                    ? `Обработано исполнителей: ${counts[1]}, треков: ${counts[2]}, аудиоанализов: ${counts[3]}.`
                    : "Обогащение медиатеки завершено.",
            };
        }
        case "Enrichment Completed with Errors":
            return {
                title: "Обогащение завершено с ошибками",
                message:
                    "Часть данных обработать не удалось. Подробности доступны в настройках обогащения.",
            };
        case "Library Scan Complete": {
            const counts =
                /Added (\d+) tracks, updated (\d+), removed (\d+)/i.exec(
                    message,
                );
            return {
                title: "Сканирование медиатеки завершено",
                message: counts
                    ? `Добавлено: ${counts[1]}, обновлено: ${counts[2]}, удалено: ${counts[3]}.`
                    : "Сканирование медиатеки завершено.",
            };
        }
        case "Playlist Tracks Matched": {
            const count = /^(\d+) previously unmatched tracks/i.exec(
                message,
            )?.[1];
            return {
                title: "Найдены треки для плейлистов",
                message: count
                    ? `Ранее не найденные треки добавлены в плейлисты: ${count}.`
                    : "Ранее не найденные треки добавлены в плейлисты.",
            };
        }
        case "Caches Cleared": {
            const count =
                /(?:Successfully cleared|Cleared) (\d+) cache entries/i.exec(
                    message,
                )?.[1];
            return {
                title: "Кэш очищен",
                message: count
                    ? `Удалено записей кэша: ${count}.`
                    : "В кэше не было записей для удаления.",
            };
        }
        case "Audiobook Sync Complete":
            return {
                title: "Синхронизация аудиокниг завершена",
                message: "Каталог аудиокниг синхронизирован.",
            };
        case "Podcast Covers Synced":
            return {
                title: "Обложки подкастов синхронизированы",
                message: "Обложки подкастов и эпизодов обновлены.",
            };
        default:
            return notification.type === "error"
                ? {
                      title: "Системная ошибка",
                      message:
                          "Операция завершилась с ошибкой. Подробности доступны в журнале сервера.",
                  }
                : {
                      title: "Системное уведомление",
                      message: "Получено новое событие от сервера.",
                  };
    }
}

/** Rebuild known server notifications in Russian from structured metadata. */
export function localizeActivityNotification(
    notification: ActivityNotificationInput,
): LocalizedActivityNotification {
    const metadata = notification.metadata;
    switch (notification.type) {
        case "download_complete": {
            const subject = metadataString(metadata, "subject");
            return {
                title: "Загрузка завершена",
                message: subject
                    ? `«${subject}» загружено и добавлено в медиатеку.`
                    : "Музыка загружена и добавлена в медиатеку.",
            };
        }
        case "download_failed": {
            const subject = metadataString(metadata, "subject");
            return {
                title: "Ошибка загрузки",
                message: subject
                    ? `Не удалось загрузить «${subject}».`
                    : "Не удалось загрузить музыку.",
            };
        }
        case "playlist_ready": {
            const name = metadataString(metadata, "playlistName");
            const count = metadataNumber(metadata, "trackCount");
            return {
                title: "Плейлист готов",
                message:
                    name && count !== null
                        ? `«${name}» готов: ${count} ${pluralRu(count, ["трек", "трека", "треков"])} `.trim()
                        : "Плейлист готов к прослушиванию.",
            };
        }
        case "import_complete": {
            const name = metadataString(metadata, "playlistName");
            const matched = metadataNumber(metadata, "matchedTracks");
            const total = metadataNumber(metadata, "totalTracks");
            return {
                title: "Импорт завершён",
                message:
                    name && matched !== null && total !== null
                        ? `«${name}»: импортировано ${matched} из ${total} треков.`
                        : "Плейлист импортирован.",
            };
        }
        case "request_submitted": {
            const release = releaseLabel(metadata);
            return {
                title: release
                    ? `Новый запрос: ${release}`
                    : "Новый запрос на музыку",
                message: "Проверьте ожидающий запрос на альбом.",
            };
        }
        case "request_approved": {
            const release = releaseLabel(metadata);
            return {
                title: "Запрос на музыку одобрен",
                message: release
                    ? `${release} загружается.`
                    : "Музыка загружается.",
            };
        }
        case "request_denied":
            return {
                title: "Запрос на музыку отклонён",
                message: "Запрос отклонён администратором.",
            };
        case "request_fulfilled": {
            const release = releaseLabel(metadata);
            return {
                title: "Запрос выполнен",
                message: release
                    ? `${release} уже в медиатеке.`
                    : "Запрошенная музыка добавлена в медиатеку.",
            };
        }
        case "request_failed":
            return {
                title: "Не удалось выполнить запрос",
                message: "Загрузка завершилась с ошибкой.",
            };
        default:
            return localizeSystemNotification(notification);
    }
}
