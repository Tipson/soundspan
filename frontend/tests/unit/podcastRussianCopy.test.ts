import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("podcast surfaces do not retain direct English UI literals", () => {
    const files = [
        "app/podcasts/page.tsx",
        "app/podcasts/[id]/page.tsx",
        "features/podcast/components/ContinueListening.tsx",
        "features/podcast/components/EpisodeList.tsx",
        "features/podcast/components/EpisodeOverflowMenu.tsx",
        "features/podcast/components/PodcastActionBar.tsx",
        "features/podcast/components/PodcastHero.tsx",
        "features/podcast/components/PreviewEpisodes.tsx",
        "features/podcast/components/SimilarPodcasts.tsx",
        "features/podcast/hooks/usePodcastActions.ts",
    ].map((path) => readFileSync(path, "utf8"));
    const source = files.join("\n");
    const forbidden = [
        'title="Podcasts"',
        'placeholder="Quick add..."',
        'placeholder="Add by RSS URL..."',
        '"Enter an RSS feed URL"',
        '"Failed to subscribe to RSS feed"',
        ">My Podcasts<",
        ">Top Podcasts<",
        ">Continue Listening<",
        ">All Episodes<",
        'title="Mark as complete"',
        'aria-label="Episode actions"',
        ">Latest Episodes<",
        ">Fans Also Like<",
        ">Subscribe<",
    ];
    for (const literal of forbidden) {
        assert.equal(source.includes(literal), false, literal);
    }
    assert.match(podcastRu.main.title, /[А-Яа-яЁё]/);
    assert.match(podcastRu.detail.notFound, /[А-Яа-яЁё]/);
});
