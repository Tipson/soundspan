import assert from "node:assert/strict";
import test from "node:test";

import {
    albumRu,
    artistRu,
    formatAlbumPreferenceSuccess,
    formatArtistLoadMoreTracks,
    formatArtistProviderLoadMoreTracks,
    formatArtistSharedRadioMessage,
    formatMixDuration,
    formatMixTrackCount,
    formatOnboardingConnectionSuccess,
    formatQueueCount,
    formatQueueSaveDescription,
    formatQueueSaved,
    mixRu,
    onboardingRu,
    queueRu,
} from "../../lib/i18n/musicPagesRu";

test("динамическая микрокопия основных музыкальных страниц склоняется по-русски", () => {
    assert.equal(formatQueueCount(1), "1 элемент в очереди");
    assert.equal(formatQueueCount(5), "5 элементов в очереди");
    assert.equal(
        formatQueueSaveDescription(22),
        "Сохранить 22 трека в новом плейлисте",
    );
    assert.equal(
        formatQueueSaved(3, "В дорогу"),
        "3 трека сохранено в плейлист «В дорогу»",
    );
    assert.equal(
        formatArtistLoadMoreTracks(50, 123),
        "Показать ещё треки (50 из 123)",
    );
    assert.equal(
        formatArtistProviderLoadMoreTracks(8, 16),
        "Показать ещё треки (проверено релизов: 8 из 16)",
    );
    assert.equal(
        formatArtistSharedRadioMessage(21),
        "Вы слушаете вместе. Радио исполнителя добавит 21 трек в общую очередь. Продолжить?",
    );
    assert.equal(
        formatAlbumPreferenceSuccess("thumbs_up", 2),
        "Отмечено как понравившиеся: 2 трека из альбома",
    );
    assert.equal(formatMixTrackCount(11), "11 треков");
    assert.equal(formatMixDuration(3720), "около 1 ч 2 мин");
});

test("названия провайдеров сохраняются, а сообщения подключения переводятся", () => {
    assert.equal(onboardingRu.lidarr, "Lidarr");
    assert.equal(onboardingRu.audiobookshelf, "Audiobookshelf");
    assert.equal(onboardingRu.soulseek, "Soulseek");
    assert.equal(
        formatOnboardingConnectionSuccess("audiobookshelf"),
        "Audiobookshelf подключён",
    );
});

test("typed-слой P0a не содержит остаточных английских команд интерфейса", () => {
    const values = [
        ...Object.values(onboardingRu),
        ...Object.values(queueRu),
        ...Object.values(artistRu),
        ...Object.values(albumRu),
        ...Object.values(mixRu),
    ];
    const forbiddenUiWords =
        /\b(?:loading|save|cancel|continue|failed|queue|tracks?|albums?|artist|mix|play|download|settings|account|integrations|enrichment|feature|available|unavailable|back|next|previous|title|duration)\b/i;

    for (const value of values) {
        assert.doesNotMatch(value, forbiddenUiWords, value);
    }
});
