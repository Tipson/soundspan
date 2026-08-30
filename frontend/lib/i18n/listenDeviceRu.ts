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
