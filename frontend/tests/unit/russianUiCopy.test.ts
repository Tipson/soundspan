import assert from "node:assert/strict";
import test from "node:test";

import { pluralRu, ru } from "../../lib/i18n/ru";

test("основная навигация и ключевые музыкальные поверхности используют русскую микрокопию", () => {
    assert.deepEqual(
        [ru.nav.home, ru.nav.vibe, ru.nav.library],
        ["Главная", "Моя волна", "Коллекция"],
    );
    assert.equal(ru.search.placeholder, "Что хотите послушать?");
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
