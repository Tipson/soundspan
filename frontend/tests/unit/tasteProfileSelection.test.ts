import assert from "node:assert/strict";
import { test } from "node:test";

import {
    addTasteLabel,
    isTasteLabelSelected,
    normalizeTasteLabels,
    validateTasteProfileSelection,
} from "../../features/taste-profile/model";
import { queryKeys } from "../../lib/queryKeys";

test("taste labels are trimmed and de-duplicated without losing their display spelling", () => {
    assert.deepEqual(
        normalizeTasteLabels(["  Рок ", "рок", "Linkin Park", "LINKIN PARK"]),
        ["Рок", "Linkin Park"],
    );
    assert.equal(isTasteLabelSelected(["linkin park"], "Linkin Park"), true);
});

test("taste selection enforces the shared 3-16 total and 10-per-kind limits", () => {
    assert.equal(
        validateTasteProfileSelection({
            genres: ["Рок", "Метал"],
            artists: [],
        }).code,
        "too-few",
    );
    assert.equal(
        validateTasteProfileSelection({
            genres: Array.from({ length: 10 }, (_, index) => `Genre ${index}`),
            artists: Array.from({ length: 7 }, (_, index) => `Artist ${index}`),
        }).code,
        "too-many-total",
    );
    assert.equal(
        validateTasteProfileSelection({
            genres: Array.from({ length: 11 }, (_, index) => `Genre ${index}`),
            artists: [],
        }).code,
        "too-many-genres",
    );
    assert.equal(
        validateTasteProfileSelection({
            genres: ["Рок"],
            artists: ["Кино", "Muse"],
        }).code,
        "valid",
    );
});

test("manual labels reject control characters and stop at the per-kind limit", () => {
    const fullSelection = {
        genres: [],
        artists: Array.from({ length: 10 }, (_, index) => `Artist ${index}`),
    };

    assert.equal(
        addTasteLabel(fullSelection, "artists", "Another artist").error,
        "В каждой группе можно выбрать не больше 10 вариантов.",
    );
    assert.equal(
        addTasteLabel({ genres: [], artists: [] }, "artists", "Bad\u0000Name")
            .error,
        "Название содержит недопустимые символы.",
    );
});

test("taste profile query keys keep account caches isolated", () => {
    assert.deepEqual(queryKeys.tasteProfile("account-a"), [
        "taste-profile",
        "account-a",
    ]);
    assert.notDeepEqual(
        queryKeys.tasteProfile("account-a"),
        queryKeys.tasteProfile("account-b"),
    );
});
