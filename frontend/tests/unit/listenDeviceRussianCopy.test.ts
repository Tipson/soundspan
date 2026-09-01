import assert from "node:assert/strict";
import test from "node:test";

import {
    deviceRu,
    formatListenTogetherMemberJoined,
    formatListenTogetherMemberLeft,
    formatListenTogetherQueueAccepted,
    formatListenTogetherQueueSkipped,
    formatListenTogetherTrackAccepted,
    formatListenTogetherTrackNext,
    formatMatchVibeConfirmation,
    formatListenerCount,
    formatReconnectStatus,
    listenTogetherFeedbackRu,
    listenTogetherRu,
} from "../../lib/i18n/listenDeviceRu";

test("динамические статусы совместного прослушивания используют русские формы", () => {
    assert.equal(formatListenerCount(1), "1 слушатель");
    assert.equal(formatListenerCount(3), "3 слушателя");
    assert.equal(formatListenerCount(11), "11 слушателей");
    assert.equal(formatReconnectStatus(0), "Переподключаемся…");
    assert.equal(formatReconnectStatus(4), "Переподключаемся (4)");
    assert.equal(
        formatListenTogetherMemberJoined("Dartum"),
        "К группе присоединился Dartum",
    );
    assert.equal(
        formatListenTogetherMemberLeft("Dartum"),
        "Dartum покинул группу",
    );
    assert.equal(
        formatListenTogetherQueueAccepted(1),
        "Добавлен 1 трек в общую очередь",
    );
    assert.equal(
        formatListenTogetherQueueAccepted(12),
        "Добавлено 12 треков в общую очередь",
    );
    assert.equal(
        formatListenTogetherQueueSkipped(3),
        "Пропущено 3 трека при обновлении общей очереди",
    );
    assert.equal(
        formatListenTogetherTrackAccepted("Солнце"),
        "«Солнце» добавлен в общую очередь",
    );
    assert.equal(
        formatListenTogetherTrackNext("Солнце"),
        "Следующий в общей очереди: «Солнце»",
    );
    assert.equal(
        formatMatchVibeConfirmation(21),
        "Вы слушаете вместе. В общую очередь будет добавлен 21 похожий трек. Продолжить?",
    );
});

test("typed-слой Listen Together и Device не содержит английских UI-команд", () => {
    const values = [
        ...Object.values(listenTogetherRu),
        ...Object.values(listenTogetherFeedbackRu),
        ...Object.values(deviceRu),
    ];
    const forbiddenUiWords =
        /\b(?:loading|create|join|public|private|group|listener|host|follower|connected|disconnected|reconnecting|connecting|queue|clear|leave|remove|copy|failed|device|linked|generate|expired|expires|scan|enter|code|last used|retry|unavailable)\b/i;

    for (const value of values) {
        assert.doesNotMatch(value, forbiddenUiWords, value);
    }
});
