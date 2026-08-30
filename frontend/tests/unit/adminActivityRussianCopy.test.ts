import assert from "node:assert/strict";
import test from "node:test";

import {
    adminActivityRu,
    formatActivityRelativeTime,
    localizeActivityNotification,
    localizeDownloadStatusText,
    translateDownloadStatus,
    translateDownloadType,
} from "../../lib/i18n/adminActivityRu";

test("Admin и панель активности используют согласованную русскую микрокопию", () => {
    assert.equal(adminActivityRu.admin.title, "Администрирование");
    assert.deepEqual(adminActivityRu.activity.tabs, {
        notifications: "Уведомления",
        active: "Активные",
        history: "История",
        imports: "Импорт",
        social: "Сейчас онлайн",
    });
    assert.equal(translateDownloadStatus("processing"), "Обрабатывается");
    assert.equal(translateDownloadType("album"), "Альбом");
});

test("динамические статусы загрузок переводятся без изменения названий провайдеров", () => {
    assert.equal(localizeDownloadStatusText("Queued"), "В очереди");
    assert.equal(
        localizeDownloadStatusText("Downloading from YouTube Music..."),
        "Загружаем из YouTube Music…",
    );
    assert.equal(
        localizeDownloadStatusText("Partial download: 2/4 tracks"),
        "Частично загружено: 2/4 треков",
    );
    assert.equal(
        localizeDownloadStatusText("TIDAL not found → youtube"),
        "TIDAL: ничего не найдено → YouTube",
    );
});

test("известные серверные уведомления отображаются по-русски из структурированных metadata", () => {
    assert.deepEqual(
        localizeActivityNotification({
            type: "playlist_ready",
            title: "Playlist Ready",
            message: '"В дорогу" is ready with 12 tracks',
            metadata: {
                playlistName: "В дорогу",
                trackCount: 12,
            },
        }),
        {
            title: "Плейлист готов",
            message: "«В дорогу» готов: 12 треков",
        },
    );
    assert.deepEqual(
        localizeActivityNotification({
            type: "request_approved",
            title: "Music Request Approved",
            message: "Artist — Album is being downloaded.",
            metadata: { artistName: "Artist", albumTitle: "Album" },
        }),
        {
            title: "Запрос на музыку одобрен",
            message: "Artist — Album загружается.",
        },
    );
});

test("системные уведомления не показывают английскую серверную микрокопию", () => {
    assert.deepEqual(
        localizeActivityNotification({
            type: "system",
            title: "Library Scan Complete",
            message: "Added 8 tracks, updated 3, removed 1",
        }),
        {
            title: "Сканирование медиатеки завершено",
            message: "Добавлено: 8, обновлено: 3, удалено: 1.",
        },
    );
    assert.deepEqual(
        localizeActivityNotification({
            type: "system",
            title: "Future Server Event",
            message: "Raw backend message",
        }),
        {
            title: "Системное уведомление",
            message: "Получено новое событие от сервера.",
        },
    );
});

test("относительное время использует русские единицы и календарь", () => {
    const now = new Date("2026-08-30T12:00:00.000Z").getTime();
    assert.equal(
        formatActivityRelativeTime("2026-08-30T11:59:30.000Z", now),
        "только что",
    );
    assert.equal(
        formatActivityRelativeTime("2026-08-30T11:55:00.000Z", now),
        "5 мин назад",
    );
    assert.equal(
        formatActivityRelativeTime("2026-08-30T10:00:00.000Z", now),
        "2 ч назад",
    );
});
