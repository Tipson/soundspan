import assert from "node:assert/strict";
import { test } from "node:test";
import {
    formatEpisodeCountRu,
    formatInProgressRu,
    formatPageRu,
    formatPodcastCountRu,
    formatPodcastDateRu,
    formatPodcastDurationRu,
    formatPodcastSearchEmptyRu,
    formatPodcastSubscribedRu,
    podcastRu,
} from "@/lib/i18n/podcastRu";

test("podcast copy formats Russian counts, dates and durations", () => {
    assert.equal(formatPodcastCountRu(1), "1 подкаст");
    assert.equal(formatPodcastCountRu(22), "22 подкаста");
    assert.equal(formatPodcastCountRu(11), "11 подкастов");
    assert.equal(formatEpisodeCountRu(1), "1 выпуск");
    assert.equal(formatEpisodeCountRu(5), "5 выпусков");
    assert.equal(formatInProgressRu(2), "2 в процессе");
    assert.equal(formatPodcastDurationRu(5_400), "1 ч 30 мин");
    assert.equal(formatPodcastDurationRu(2_700), "45 мин");
    assert.equal(formatPageRu(2, 7), "Страница 2 из 7");
    assert.match(
        formatPodcastDateRu("2026-08-20T12:00:00.000Z"),
        /20 авг\. 2026 г\./,
    );
});

test("dynamic podcast messages preserve catalog metadata", () => {
    assert.equal(
        formatPodcastSearchEmptyRu("Syntax"),
        "По запросу «Syntax» подкасты не найдены",
    );
    assert.equal(
        formatPodcastSubscribedRu("Syntax"),
        "Вы подписались на «Syntax»",
    );
});

test("podcast action and state labels remain Russian", () => {
    const labels = [
        podcastRu.main.title,
        podcastRu.detail.notFound,
        podcastRu.detail.subscribe,
        podcastRu.detail.episodeActions,
        podcastRu.detail.playNext,
        podcastRu.detail.addToQueue,
        podcastRu.detail.markComplete,
        podcastRu.detail.cancel,
        podcastRu.detail.newestFirst,
        podcastRu.detail.oldestFirst,
    ];
    for (const label of labels) assert.match(label, /[А-Яа-яЁё]/);
    assert.equal(podcastRu.detail.playNext, "Воспроизвести следующим");
    assert.equal(podcastRu.detail.markComplete, "Отметить прослушанным");
});
