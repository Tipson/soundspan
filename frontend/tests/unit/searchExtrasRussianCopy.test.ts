import assert from "node:assert/strict";
import { test } from "node:test";
import {
    formatAliasResolution,
    formatSearchArtistListeners,
    formatYouTubeBulkStopped,
    formatYouTubeBulkSuccess,
    formatYouTubeBulkUnfinished,
    formatYouTubePlaylistPreviewCount,
    formatYouTubePlaylistRemaining,
    formatYouTubePlaylistDuration,
    formatYouTubePlaylistTrackCount,
    formatYouTubeTracksAdded,
    searchExtrasRu,
} from "../../lib/i18n/searchExtrasRu";

function collectStrings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (!value || typeof value !== "object") return [];
    return Object.values(value).flatMap(collectStrings);
}

test("search extras format Russian count-aware copy", () => {
    assert.equal(formatYouTubePlaylistTrackCount(1), "1 трек");
    assert.equal(formatYouTubePlaylistTrackCount(4), "4 трека");
    assert.equal(formatYouTubePlaylistTrackCount(12), "12 треков");
    assert.equal(formatYouTubePlaylistDuration(3_720), "около 1 ч 2 мин");
    assert.equal(formatYouTubeTracksAdded(21), "Добавлен в очередь 21 трек");
    assert.equal(formatSearchArtistListeners(undefined), "Исполнитель");
    assert.equal(formatSearchArtistListeners(1_200), "1,2 тыс. слушателей");
    assert.equal(
        formatAliasResolution("Linkin Park", "линкин парк"),
        "Показаны результаты для Linkin Park (по запросу «линкин парк»)",
    );
    assert.equal(
        formatYouTubePlaylistPreviewCount(3, 500, true),
        "Показаны первые 3 из 500 треков",
    );
    assert.equal(formatYouTubePlaylistPreviewCount(3, 3, false), "3 трека");
    assert.equal(formatYouTubePlaylistRemaining(21), "+21 трек");
    assert.equal(
        formatYouTubeBulkStopped(2, 3),
        "Остановлено — загружено 2 из 3",
    );
    assert.equal(
        formatYouTubeBulkSuccess(3, 3),
        "Загружено 3 из 3 — сканируем медиатеку",
    );
    assert.equal(
        formatYouTubeBulkUnfinished(2, 3, 1),
        "Загружено 2 из 3, не завершён 1 файл",
    );
});

test("search extras keep visible copy Russian apart from product and key names", () => {
    const residual = collectStrings(searchExtrasRu)
        .map((value) =>
            value
                .replaceAll("YouTube Music", "")
                .replaceAll("YouTube", "")
                .replaceAll("Soulseek", "")
                .replaceAll("Enter", "")
                .replaceAll("URL", ""),
        )
        .filter((value) => /[A-Za-z]{3,}/.test(value));

    assert.deepEqual(residual, []);
});
