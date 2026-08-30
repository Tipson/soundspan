import { pluralRu } from "./ru";

/** Russian copy for the shared-listening surface. */
export const listenTogetherRu = {
    routeUnavailableToast: "Совместное прослушивание сейчас недоступно.",
    routeUnavailableTitle: "Совместное прослушивание недоступно",
    routeErrorFallback:
        "Не удалось подключиться к сервису совместного прослушивания.",
    routeSetupPrefix: "Убедитесь, что",
    routeSetupMiddle: "передаёт запросы в Socket.IO бэкенда. См.",
    retryRoute: "Проверить снова",
    checkingRoute: "Проверяем подключение…",
    createTitle: "Создать группу",
    createDescription: "Начните сеанс и пригласите друзей",
    groupNamePlaceholder: "Название группы (необязательно)",
    publicGroup: "Открытая группа",
    privateGroup: "Закрытая группа",
    visibilitySwitch: "Доступность группы",
    useCurrentQueue: "Использовать текущую очередь",
    currentQueueSwitch: "Использовать текущую очередь",
    joinTitle: "Присоединиться к группе",
    joinDescription: "Введите код приглашения",
    joinCodePlaceholder: "Код приглашения",
    join: "Войти",
    actionFailed: "Не удалось выполнить действие.",
    publicGroups: "Открытые группы",
    publicGroupsDescription: "Присоединитесь к открытому сеансу",
    refreshPublicGroups: "Обновить список открытых групп",
    noPublicGroups: "Сейчас открытых групп нет",
    joinCodeCopied: "Код приглашения скопирован",
    copyFailed: "Не удалось скопировать код",
    routeLost: "Подключение к сервису потеряно",
    host: "Ведущий",
    follower: "Участник",
    routeNeeded: "Нужна настройка подключения",
    connected: "Подключено",
    connecting: "Подключаемся…",
    nothingPlaying: "Пока ничего не играет",
    copyJoinCode: "Скопировать код приглашения",
    queue: "Очередь",
    clearQueue: "Очистить",
    emptyQueue: "Очередь пуста",
    emptyQueueHint: "Добавьте треки из своей коллекции",
    listeners: "Слушатели",
    disconnected: "Не в сети",
    leaveGroup: "Покинуть группу",
    removeFromQueue: "Удалить из очереди",
    title: "Слушаем вместе",
    subtitle: "Слушайте музыку с друзьями синхронно",
    loading: "Загружаем сеанс…",
} as const satisfies Record<string, string>;

/** Russian feedback and failure copy emitted by shared-listening controls. */
export const listenTogetherFeedbackRu = {
    leftGroup: "Вы покинули группу совместного прослушивания",
    nowHost: "Теперь вы ведущий!",
    groupCreated: "Группа создана!",
    groupJoined: "Вы присоединились к группе!",
    groupLeft: "Вы покинули группу",
    sessionEnded: "Сеанс совместного прослушивания завершён",
    createFailed: "Не удалось создать группу",
    joinFailed: "Не удалось присоединиться к группе",
    leaveFailed: "Не удалось покинуть группу",
    leaveFailedBackground: "Не удалось завершить выход из группы в фоне",
    queueFirst500: "В общей очереди сохранены первые 500 треков",
    queueFull: "Общая очередь уже содержит 500 треков",
    queueLimit: "В общей очереди можно сохранить не более 500 треков.",
    prepareTrackFailed:
        "Не удалось подготовить трек для совместного прослушивания",
    noValidTracks: "Нет доступных треков для добавления в общую очередь",
    someTracksSkipped:
        "Некоторые треки не удалось подготовить для общей очереди",
    addTrackFailed: "Не удалось добавить трек в общую очередь",
    addTracksFailed: "Не удалось добавить треки в общую очередь",
    removeFromQueueFailed: "Не удалось удалить трек из общей очереди",
    clearQueueFailed: "Не удалось очистить общую очередь",
    audiobookUnsupported:
        "Аудиокниги не поддерживаются в совместном прослушивании",
    podcastUnsupported: "Подкасты не поддерживаются в совместном прослушивании",
    matchVibeCancelled: "Подбор похожей музыки отменён",
    matchVibeFailed: "Не удалось подобрать похожую музыку",
    reconnectFailed:
        "Не удалось переподключиться к совместному прослушиванию. Проверьте подключение и войдите в группу снова.",
    routeRequired:
        "Для совместного прослушивания требуется маршрутизация Socket.IO. Проверьте настройки прокси или туннеля.",
    routeNotConfigured: "Маршрут для совместного прослушивания не настроен",
    requestFailed: "Запрос совместного прослушивания не выполнен",
} as const satisfies Record<string, string>;

/** Toast shown when another listener joins the group. */
export function formatListenTogetherMemberJoined(username: string): string {
    return `К группе присоединился ${username}`;
}

/** Toast shown when another listener leaves the group. */
export function formatListenTogetherMemberLeft(username: string): string {
    return `${username} покинул группу`;
}

/** Success feedback after tracks enter the shared queue. */
export function formatListenTogetherQueueAccepted(count: number): string {
    const verb =
        count % 10 === 1 && count % 100 !== 11 ? "Добавлен" : "Добавлено";
    return `${verb} ${count} ${pluralRu(count, ["трек", "трека", "треков"])} в общую очередь`;
}

/** Warning feedback after queue entries are rejected or truncated. */
export function formatListenTogetherQueueSkipped(count: number): string {
    return `Пропущено ${count} ${pluralRu(count, ["трек", "трека", "треков"])} при обновлении общей очереди`;
}

/** Success after one named track enters the shared queue. */
export function formatListenTogetherTrackAccepted(title: string): string {
    return `«${title}» добавлен в общую очередь`;
}

/** Success after one named track is inserted after the current shared item. */
export function formatListenTogetherTrackNext(title: string): string {
    return `Следующий в общей очереди: «${title}»`;
}

/** Confirmation before Match Vibe mutates a shared queue. */
export function formatMatchVibeConfirmation(count: number): string {
    const verb =
        count % 10 === 1 && count % 100 !== 11
            ? "будет добавлен"
            : "будет добавлено";
    return `Вы слушаете вместе. В общую очередь ${verb} ${count} ${pluralRu(count, ["похожий трек", "похожих трека", "похожих треков"])}. Продолжить?`;
}

/** Russian listener count with the correct noun form. */
export function formatListenerCount(count: number): string {
    return `${count} ${pluralRu(count, ["слушатель", "слушателя", "слушателей"])}`;
}

/** Russian reconnect label that preserves the transport attempt number. */
export function formatReconnectStatus(attempt: number): string {
    return attempt > 0 ? `Переподключаемся (${attempt})` : "Переподключаемся…";
}

/** Russian copy for linking and managing companion devices. */
export const deviceRu = {
    loadFailed: "Не удалось загрузить список устройств.",
    generateFailed: "Не удалось создать код привязки.",
    revokeFailed: "Не удалось отвязать устройство.",
    title: "Привязка устройства",
    subtitle: "Отсканируйте QR-код или введите код в совместимом клиенте",
    pwaDirection:
        "На телефоне рекомендуем PWA. Для нативных мобильных клиентов подойдут приложения с поддержкой Subsonic.",
    linkCodeTitle: "Код привязки",
    generateHint: "Создайте одноразовый код для совместимого устройства",
    generateCode: "Создать код",
    linkedTitle: "Устройство привязано",
    linkedDescription: "Устройство успешно подключено",
    linkAnother: "Привязать ещё одно устройство",
    expiredTitle: "Срок действия кода истёк",
    expiredDescription: "Создайте новый код, чтобы продолжить",
    generateNewCode: "Создать новый код",
    uriScheme: "URI-схема для клиента:",
    manualCode: "Или введите этот код вручную:",
    copyCode: "Скопировать код",
    expiresIn: "Код истечёт через",
    linkedDevices: "Привязанные устройства",
    noDevices: "Пока нет привязанных устройств",
    lastUsed: "Последнее использование:",
    revokeDevice: "Отвязать устройство",
    instructionsTitle: "Как привязать устройство",
    instructionOpen: "Откройте на устройстве совместимый мобильный клиент",
    instructionChoose:
        "Если клиент поддерживает этот сценарий, выберите сканирование QR-кода или ручной ввод кода",
    instructionScan: "Отсканируйте QR-код выше или введите шестизначный код",
    instructionVerify:
        "После проверки в клиенте устройство будет привязано к вашему аккаунту",
} as const satisfies Record<string, string>;
