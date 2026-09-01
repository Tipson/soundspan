import assert from "node:assert/strict";
import test from "node:test";
import {
    browseCollectionCopy,
    formatTotalDuration,
    kindTitle,
} from "../../features/explore/browseCollectionCopy";
import { resolveConnectionTestOutcome } from "../../features/settings/hooks/useConnectionTest";

test("kindTitle renders title case for both kinds", () => {
    assert.equal(kindTitle("playlist"), "Плейлист");
    assert.equal(kindTitle("mix"), "Микс");
});

test("browseCollectionCopy matches the pre-consolidation playlist wording", () => {
    const copy = browseCollectionCopy("playlist");
    assert.equal(copy.heroLabel, "TIDAL Плейлист");
    assert.equal(copy.loadErrorFallback, "Не удалось загрузить плейлист");
    assert.equal(
        copy.noPlayableTracks,
        "В этом плейлисте нет доступных треков",
    );
    assert.equal(copy.notFoundTitle, "Плейлист не найден");
    assert.equal(
        copy.notFoundFallback,
        "Плейлист может быть приватным или уже недоступным.",
    );
    assert.equal(copy.emptyMessage, "Плейлист, похоже, пуст");
});

test("browseCollectionCopy matches the pre-consolidation mix wording", () => {
    const copy = browseCollectionCopy("mix");
    assert.equal(copy.heroLabel, "TIDAL Микс");
    assert.equal(copy.loadErrorFallback, "Не удалось загрузить микс");
    assert.equal(copy.noPlayableTracks, "В этом миксе нет доступных треков");
    assert.equal(copy.notFoundTitle, "Микс не найден");
    assert.equal(
        copy.notFoundFallback,
        "Микс может быть приватным или уже недоступным.",
    );
    assert.equal(copy.emptyMessage, "Микс, похоже, пуст");
});

test("formatTotalDuration matches the original hour and minute forms", () => {
    assert.equal(formatTotalDuration(9000), "около 2 ч 30 мин");
    assert.equal(formatTotalDuration(3600), "около 1 ч 0 мин");
    assert.equal(formatTotalDuration(2700), "45 мин");
    assert.equal(formatTotalDuration(0), "0 мин");
});

test("connection test outcome uses static success messages", () => {
    assert.deepEqual(
        resolveConnectionTestOutcome(
            { success: true },
            { successMessage: "Connected to TIDAL" },
        ),
        { status: "success", message: "Connected to TIDAL" },
    );
});

test("connection test outcome derives version success messages", () => {
    const messages = {
        successMessage: (r: { success: boolean; version?: string }) =>
            r.version ? `v${r.version}` : "Connected",
        failureMessage: "Failed",
    };
    assert.deepEqual(
        resolveConnectionTestOutcome(
            { success: true, version: "2.1" },
            messages,
        ),
        { status: "success", message: "v2.1" },
    );
    assert.deepEqual(
        resolveConnectionTestOutcome({ success: true }, messages),
        {
            status: "success",
            message: "Connected",
        },
    );
});

test("connection test outcome prefers the probe error then the fallback", () => {
    assert.deepEqual(
        resolveConnectionTestOutcome(
            { success: false, error: "ECONNREFUSED" },
            { successMessage: "Connected", failureMessage: "Failed" },
        ),
        { status: "error", message: "Failed" },
    );
    assert.deepEqual(
        resolveConnectionTestOutcome(
            { success: false },
            { successMessage: "Connected", failureMessage: "Failed" },
        ),
        { status: "error", message: "Failed" },
    );
    assert.deepEqual(
        resolveConnectionTestOutcome(
            { success: false },
            { successMessage: "Connected" },
        ),
        { status: "error", message: "Не удалось подключиться" },
    );
});
