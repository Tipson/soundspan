import type {
    FederationHealthState,
    FederationPeerHealth,
    FederationPeerStatus,
} from "@/lib/api/federation";
import { pluralRu } from "./ru";

/** Russian copy for account administration and server federation. */
export const adminManagementRu = {
    users: {
        title: "Управление пользователями",
        description: "Управляйте аккаунтами с доступом к этому серверу.",
        createTitle: "Создать пользователя",
        username: "Имя пользователя",
        password: "Пароль (не менее 6 символов)",
        user: "Пользователь",
        admin: "Администратор",
        creating: "Создаём…",
        create: "Создать",
        created: "Пользователь создан",
        deleted: "Пользователь удалён",
        invalidCredentials:
            "Укажите имя пользователя и пароль не короче 6 символов.",
        genericError: "Не удалось выполнить действие с пользователем.",
        invites: "Коды приглашения",
        oneHour: "1 час",
        sixHours: "6 часов",
        oneDay: "24 часа",
        sevenDays: "7 дней",
        thirtyDays: "30 дней",
        neverExpires: "Без срока действия",
        maxUses: "Максимум использований",
        generating: "Создаём…",
        generateInvite: "Создать приглашение",
        inviteGenerated: "Код приглашения создан",
        copyInvite: "Скопировать ссылку-приглашение",
        revokeInvite: "Отозвать код приглашения",
        uses: "использований",
        never: "Без срока",
        expired: "Срок истёк",
        left: "осталось",
        connectedNow: "Сейчас подключены",
        online: "онлайн",
        checkingConnected: "Проверяем подключённых пользователей…",
        noConnected: "Сейчас нет подключённых пользователей",
        you: "вы",
        loading: "Загружаем пользователей…",
        empty: "Пользователи не найдены",
        editTitle: "Редактирование пользователя",
        role: "Роль",
        oidcRoleWarning:
            "Управление ролями OIDC (если оно включено) заменит ручное изменение роли при следующем входе этого пользователя через SSO.",
        email: "Электронная почта",
        newPassword: "Новый пароль",
        setPassword: "Задать пароль (включит локальный вход)",
        keepPassword: "Оставьте пустым, чтобы сохранить текущий пароль",
        remainSsoOnly: "Оставьте пустым, чтобы сохранить вход только через SSO",
        cancel: "Отмена",
        saving: "Сохраняем…",
        saveChanges: "Сохранить изменения",
        saved: "Изменения сохранены",
        passwordTooShort: "Пароль должен содержать не менее 6 символов.",
        noChanges: "Нет изменений для сохранения.",
        deleteTitle: "Удалить пользователя",
        deleteQuestion:
            "Удалить этого пользователя? Это действие нельзя отменить.",
        delete: "Удалить",
        ssoOnly: "только SSO",
        noLocalPassword: "Нет локального пароля",
        inviteStatuses: {
            active: "Активен",
            expired: "Истёк",
            exhausted: "Использован",
            revoked: "Отозван",
        },
    },
    federation: {
        title: "Федерация",
        description:
            "Связывайте доверенные серверы soundspan для чтения медиатеки и воспроизведения.",
        empty: "Нет связанных серверов.",
        sharing: "Делимся с ними",
        consuming: "Слушаем с их сервера",
        noRemoteUrl: "Нет удалённого URL — они подключаются к этому серверу",
        neverSeen: "Ещё не подключался",
        lastSeenUnknown: "Время последнего подключения неизвестно",
        lastSeen: "Последнее подключение",
        settings: "Настройки",
        hideSettings: "Скрыть настройки",
        dedupMatches: "Совпадения треков",
        hideDedupMatches: "Скрыть совпадения",
        syncNow: "Синхронизировать",
        rotate: "Заменить токен",
        revoke: "Отозвать",
        delete: "Удалить",
        credentialFor: "Данные доступа для",
        copyTokenWarning: "Скопируйте токен сейчас: мы больше не покажем его.",
        copied: "Скопировано",
        copyToken: "Скопировать токен",
        done: "Готово",
        deleteTitle: "Удалить связанный сервер?",
        deleteMessage: "и все синхронизированные с ним данные?",
        thisPeer: "этот сервер",
        instanceName: "Название этого сервера",
        instanceNameDescription:
            "Так сервер представляется другим участникам. Оставьте поле пустым, чтобы использовать имя хоста.",
        instanceNamePlaceholder: "Мой музыкальный сервер",
        shareLibrary: "Поделиться моей медиатекой",
        shareLibraryDescription:
            "Разрешите другому серверу soundspan читать эту медиатеку. Создайте данные доступа и безопасно передайте их другому администратору: они показываются один раз.",
        shareWithName: "Название сервера, с которым вы делитесь",
        familyServer: "Семейный сервер",
        shareEmbeddings: "Также делиться эмбеддингами (для функций Vibe)",
        presenceExplanation:
            "Обмен онлайн-статусом уже включён в протокол: пользователи, которые разрешили «Делиться статусом онлайн» в социальных настройках, появятся во вкладке активности другого сервера. Статусы остальных пользователей не передаются.",
        issueCredential: "Выдать данные доступа",
        connectLibrary: "Подключиться к медиатеке",
        connectLibraryDescription:
            "Используйте токен, который выдал администратор другого сервера, чтобы читать его медиатеку.",
        peerName: "Название сервера",
        friendServer: "Сервер друга",
        peerUrl: "URL сервера",
        token: "Токен",
        connectToken: "Подключить по токену",
        twoWayExplanation:
            "Двусторонний обмен состоит из двух отдельных шагов: вы подключаетесь к ним по выданному ими токену, а они подключаются к вам по данным доступа, которые создаёте вы. Каждое направление настраивается независимо и явно.",
        showDuplicateCopies:
            "Показывать копии уже имеющихся треков с этого сервера",
        maxStreams: "Максимум потоков",
        maxKbps: "Максимум kbps",
        saving: "Сохраняем…",
        saveSettings: "Сохранить настройки",
        loadDedup: "Загружаем совпадения треков…",
        noDedup: "Для этого сервера нет объединённых треков.",
        loadMore: "Загрузить ещё",
        hiddenBehind: "Скрыт за локальным треком",
        notLinked: "Не связан с локальным треком",
        pinned: "закреплено",
        unlink: "Отвязать",
        rematch: "Сопоставить заново",
        genericError: "Не удалось выполнить запрос федерации",
        saveSettingsError: "Не удалось сохранить настройки сервера",
        loadDedupError: "Не удалось загрузить совпадения треков",
        updateDedupError: "Не удалось изменить сопоставление трека",
        errors: {
            unreachable:
                "Не удалось связаться с сервером. Проверьте URL и доступность сервера.",
            tls: "Не удалось проверить TLS-сертификат сервера. Для федерации требуется действительный HTTPS-сертификат.",
            unauthorized:
                "Сервер отклонил данные доступа. Возможно, токен отозван или заменён.",
            invalid:
                "Ответ сервера несовместим с soundspan. Проверьте, что URL ведёт к backend.",
            conflict:
                "Связь с этим URL уже существует. Сначала отзовите или удалите её.",
        },
        statuses: {
            ACTIVE: "Активно",
            OFFLINE: "Не в сети",
            REVOKED: "Отозвано",
            PENDING: "Ожидает",
        },
        health: {
            title: "Состояние связанных серверов",
            refresh: "Обновить состояние связанных серверов",
            loading: "Загружаем состояние серверов…",
            empty: "Данных о состоянии связанных серверов пока нет.",
            requestFailed: "Не удалось получить состояние серверов.",
            neverSynced: "Ещё не синхронизировано",
            syncUnknown: "Время синхронизации неизвестно",
            sync: "Синхронизация",
            notApplicable: "не применяется",
            duration: "за",
            artists: "исполнителей",
            albums: "альбомов",
            tracks: "треков",
            audiobooks: "аудиокниг",
            podcasts: "подкастов",
            activeStreams: "Активных потоков",
            embeddingsActive: "Эмбеддинги: передаются",
            embeddingsMismatch:
                "Эмбеддинги не передаются: пространства не совпадают, другой сервер нужно обновить.",
            sharingAndConsuming: "Делимся и слушаем",
            sharingOnly: "Делимся с ними",
            consumingOnly: "Слушаем с их сервера",
            states: {
                green: "Работает",
                amber: "Требует внимания",
                red: "Ошибка",
                revoked: "Отозвано",
            },
            errorClasses: {
                unreachable: "Сервер недоступен",
                tls: "Ошибка проверки TLS",
                unauthorized: "Доступ отклонён",
                peer_invalid: "Некорректный ответ сервера",
            },
            genericPeerError: "Последняя операция завершилась с ошибкой",
        },
    },
} as const;

const USER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
    "Cannot demote the last admin":
        "Нельзя понизить роль последнего администратора.",
    "Cannot delete the last admin": "Нельзя удалить последнего администратора.",
    "Cannot delete your own account":
        "Нельзя удалить собственный аккаунт из этой панели.",
    "Username already taken": "Это имя пользователя уже занято.",
    "Username and password are required": "Укажите имя пользователя и пароль.",
    "Failed to create invite code": "Не удалось создать код приглашения.",
    "Failed to list invite codes": "Не удалось загрузить коды приглашения.",
    "Failed to revoke invite code": "Не удалось отозвать код приглашения.",
    "Invite code not found": "Код приглашения не найден.",
};

/** Hide raw backend prose while preserving known actionable user errors. */
export function localizeUserManagementError(error: unknown): string {
    const message = error instanceof Error ? error.message.trim() : "";
    return USER_ERROR_MESSAGES[message] ?? adminManagementRu.users.genericError;
}

/** Human-readable invite lifecycle label. */
export function inviteStatusLabel(status: string): string {
    return (
        adminManagementRu.users.inviteStatuses[
            status as keyof typeof adminManagementRu.users.inviteStatuses
        ] ?? status
    );
}

/** Compact Russian invite expiry label. */
export function formatInviteExpiry(
    expiresAt: string | null,
    now = new Date(),
): string {
    if (!expiresAt) return adminManagementRu.users.never;
    const date = new Date(expiresAt);
    if (!Number.isFinite(date.getTime()) || date < now) {
        return adminManagementRu.users.expired;
    }
    const minutes = Math.max(
        0,
        Math.floor((date.getTime() - now.getTime()) / 60_000),
    );
    if (minutes >= 24 * 60) {
        const days = Math.floor(minutes / (24 * 60));
        return `${days} ${pluralRu(days, ["день", "дня", "дней"])} ${adminManagementRu.users.left}`;
    }
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        return `${hours} ${pluralRu(hours, ["час", "часа", "часов"])} ${adminManagementRu.users.left}`;
    }
    return `${minutes} мин ${adminManagementRu.users.left}`;
}

const FEDERATION_ERROR_MESSAGES: Readonly<Record<string, string>> = {
    FEDERATION_PEER_UNREACHABLE:
        adminManagementRu.federation.errors.unreachable,
    FEDERATION_PEER_TLS: adminManagementRu.federation.errors.tls,
    FEDERATION_PEER_UNAUTHORIZED:
        adminManagementRu.federation.errors.unauthorized,
    FEDERATION_PEER_INVALID: adminManagementRu.federation.errors.invalid,
    FEDERATION_PEER_CONFLICT: adminManagementRu.federation.errors.conflict,
};

/** Map federation failures to safe Russian admin guidance. */
export function federationRequestError(error: unknown): string {
    if (error instanceof Error) {
        const data = (error as Error & { data?: Record<string, unknown> }).data;
        const code = typeof data?.code === "string" ? data.code : null;
        if (code && FEDERATION_ERROR_MESSAGES[code]) {
            return FEDERATION_ERROR_MESSAGES[code];
        }
    }
    return adminManagementRu.federation.genericError;
}

/** Translate the stable federation connection state enum. */
export function federationStatusLabel(
    status: FederationPeerStatus | null,
): string {
    return adminManagementRu.federation.statuses[status ?? "PENDING"];
}

/** Compact Russian freshness for federation health. */
export function formatFederationFreshness(
    value: string | null,
    now: Date,
): string {
    if (!value) return adminManagementRu.federation.health.neverSynced;
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) {
        return adminManagementRu.federation.health.syncUnknown;
    }
    const seconds = Math.max(
        0,
        Math.floor((now.getTime() - timestamp) / 1_000),
    );
    if (seconds < 60) return `${seconds} с назад`;
    if (seconds < 3_600) return `${Math.floor(seconds / 60)} мин назад`;
    if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} ч назад`;
    return `${Math.floor(seconds / 86_400)} дн назад`;
}

/** Translate the stable health state without exposing protocol enums. */
export function federationHealthStateLabel(
    state: FederationHealthState,
): string {
    return adminManagementRu.federation.health.states[state];
}

/** Safe localized detail for a peer's last health error. */
export function federationPeerErrorDetail(peer: FederationPeerHealth): string {
    const label = peer.lastErrorClass
        ? adminManagementRu.federation.health.errorClasses[peer.lastErrorClass]
        : adminManagementRu.federation.health.genericPeerError;
    if (!peer.lastErrorAt) return label;
    const timestamp = new Date(peer.lastErrorAt);
    if (!Number.isFinite(timestamp.getTime())) return label;
    return `${label} · ${timestamp.toLocaleString("ru-RU")}`;
}
