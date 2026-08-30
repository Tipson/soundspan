import assert from "node:assert/strict";
import test from "node:test";

import {
    deviceRu,
    formatListenerCount,
    formatReconnectStatus,
    listenTogetherRu,
} from "../../lib/i18n/listenDeviceRu";

test("динамические статусы совместного прослушивания используют русские формы", () => {
    assert.equal(formatListenerCount(1), "1 слушатель");
    assert.equal(formatListenerCount(3), "3 слушателя");
    assert.equal(formatListenerCount(11), "11 слушателей");
    assert.equal(formatReconnectStatus(0), "Переподключаемся…");
    assert.equal(formatReconnectStatus(4), "Переподключаемся (4)");
});

test("typed-слой Listen Together и Device не содержит английских UI-команд", () => {
    const values = [
        ...Object.values(listenTogetherRu),
        ...Object.values(deviceRu),
    ];
    const forbiddenUiWords =
        /\b(?:loading|create|join|public|private|group|listener|host|follower|connected|disconnected|reconnecting|connecting|queue|clear|leave|remove|copy|failed|device|linked|generate|expired|expires|scan|enter|code|last used|retry|unavailable)\b/i;

    for (const value of values) {
        assert.doesNotMatch(value, forbiddenUiWords, value);
    }
});
