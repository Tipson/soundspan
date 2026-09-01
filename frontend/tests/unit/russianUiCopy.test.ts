import assert from "node:assert/strict";
import test from "node:test";

import { pluralRu, ru, userFacingError } from "../../lib/i18n/ru";

test("основная навигация и ключевые музыкальные поверхности используют русскую микрокопию", () => {
    assert.deepEqual(
        [ru.nav.home, ru.nav.vibe, ru.nav.library],
        ["Главная", "Волна", "Моя музыка"],
    );
    assert.equal(
        ru.search.placeholder,
        "Найти трек, исполнителя, альбом или плейлист",
    );
    assert.equal(ru.library.title, "Моя коллекция");
    assert.equal(ru.vibe.tuneTitle, "Настроить мою волну");
});

test("pluralRu выбирает русскую форму числительного", () => {
    const forms = ["трек", "трека", "треков"] as const;

    assert.equal(pluralRu(1, forms), "трек");
    assert.equal(pluralRu(2, forms), "трека");
    assert.equal(pluralRu(5, forms), "треков");
    assert.equal(pluralRu(21, forms), "трек");
    assert.equal(pluralRu(11, forms), "треков");
});

test("userFacingError не показывает английские серверные ошибки", () => {
    assert.equal(
        userFacingError(
            new Error("Interactive session authentication required"),
            "Не удалось выполнить действие",
        ),
        ru.errors.interactiveSessionRequired,
    );
    assert.equal(
        userFacingError(new Error("Unknown backend failure"), "Сбой операции"),
        "Сбой операции",
    );
    assert.equal(
        userFacingError(new Error("Ошибка уже переведена"), "Сбой операции"),
        "Ошибка уже переведена",
    );
});
