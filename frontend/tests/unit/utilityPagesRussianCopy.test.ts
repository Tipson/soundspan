import assert from "node:assert/strict";
import test from "node:test";

import {
    formatImportResolutionSubtitle,
    formatImportSongsFound,
    formatShareCount,
    formatShareOwner,
    importPageRu,
    radioRu,
    shareRu,
    syncRu,
} from "../../lib/i18n/utilityPagesRu";

test("динамический текст Import и Share использует русские формы", () => {
    assert.equal(formatImportSongsFound(21), "Найден 21 трек");
    assert.equal(formatImportSongsFound(24), "Найдено 24 трека");
    assert.equal(formatShareCount(5, "playlist"), "5 элементов");
    assert.equal(formatShareCount(12, "tracks"), "12 треков");
    assert.equal(formatShareOwner("Oleg"), "Автор: Oleg");
});

test("статус сопоставления сохраняет числовую уверенность, но переводит подпись", () => {
    assert.equal(
        formatImportResolutionSubtitle({ source: "unresolved", confidence: 0 }),
        "Совпадение у провайдеров не найдено",
    );
    assert.equal(
        formatImportResolutionSubtitle({ source: "youtube", confidence: 98 }),
        "Уверенность: 98%",
    );
    assert.equal(
        formatImportResolutionSubtitle({ source: "tidal", confidence: 0 }),
        "Найдено совпадение",
    );
});

test("typed-слой служебных музыкальных страниц не содержит английских UI-команд", () => {
    const values = [
        ...Object.values(importPageRu),
        ...Object.values(shareRu),
        ...Object.values(syncRu),
        ...Object.values(radioRu),
    ];
    const forbiddenUiWords =
        /\b(?:loading|shared|link|download|previous|next|play|pause|mute|volume|scanning|syncing|ready|skip|radio|station|library|tracks?|items?|playlist|failed|resolved|confidence|quick|genre|decade|favorites|workout|discovery)\b/i;

    for (const value of values) {
        assert.doesNotMatch(value, forbiddenUiWords, value);
    }
});
