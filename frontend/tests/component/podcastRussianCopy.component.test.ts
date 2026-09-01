import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        ArrowUpDown: Icon,
        Check: Icon,
        CheckCircle: Icon,
        EllipsisVertical: Icon,
        ExternalLink: Icon,
        ListEnd: Icon,
        ListPlus: Icon,
        Loader2: Icon,
        Mic2: Icon,
        Pause: Icon,
        Play: Icon,
        Plus: Icon,
        Trash2: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useRouter: () => ({ push: () => undefined }),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", props),
});

test("podcast detail components render Russian product copy", async () => {
    const [{ PodcastHero }, { PodcastActionBar }, { EpisodeList }] =
        await Promise.all([
            import("../../features/podcast/components/PodcastHero"),
            import("../../features/podcast/components/PodcastActionBar"),
            import("../../features/podcast/components/EpisodeList"),
        ]);

    const hero = renderToStaticMarkup(
        React.createElement(PodcastHero, {
            title: "Syntax",
            author: "Wes Bos",
            description:
                "<scr<script>ipt>alert('nested')</scr<script>ipt><p>Описание подкаста</p>",
            heroImage: null,
            colors: null,
            episodeCount: 2,
            inProgressCount: 1,
        }),
    );
    assert.match(hero, />Подкаст</);
    assert.match(hero, /2 выпуска/);
    assert.match(hero, /1 в процессе/);
    assert.match(hero, /alert\(&#x27;nested&#x27;\)Описание подкаста/);
    assert.doesNotMatch(hero, /(?:&lt;|<)script/i);
    assert.doesNotMatch(hero, /ipt&gt;/i);

    const actions = renderToStaticMarkup(
        React.createElement(PodcastActionBar, {
            isSubscribed: false,
            colors: null,
            isSubscribing: false,
            showDeleteConfirm: false,
            onSubscribe: () => undefined,
            onRemove: () => undefined,
            onShowDeleteConfirm: () => undefined,
        }),
    );
    assert.match(actions, />Подписаться</);

    const episodes = renderToStaticMarkup(
        React.createElement(EpisodeList, {
            podcast: {
                id: "podcast-1",
                title: "Syntax",
                author: "Wes Bos",
                coverUrl: "",
                autoDownloadEpisodes: false,
                episodes: [],
            },
            episodes: [],
            sortOrder: "newest",
            onSortOrderChange: () => undefined,
            isEpisodePlaying: () => false,
            isPlaying: false,
            onPlayPause: () => undefined,
            onPlay: () => undefined,
        }),
    );
    assert.match(episodes, /Все выпуски/);
    assert.match(episodes, /Сначала новые/);
});

test("podcast preview and related sections render Russian empty copy", async () => {
    const [{ PreviewEpisodes }, { SimilarPodcasts }] = await Promise.all([
        import("../../features/podcast/components/PreviewEpisodes"),
        import("../../features/podcast/components/SimilarPodcasts"),
    ]);
    const preview = renderToStaticMarkup(
        React.createElement(PreviewEpisodes, {
            previewData: {
                itunesId: "1",
                title: "Syntax",
                author: "Wes Bos",
                feedUrl: "https://example.test/feed.xml",
                coverUrl: "",
                description: "",
                genres: [],
                episodeCount: 0,
                previewEpisodes: [],
                isSubscribed: false,
            },
            colors: null,
            isSubscribing: false,
            onSubscribe: () => undefined,
        }),
    );
    assert.match(preview, /Последние выпуски/);
    assert.match(preview, /Нет выпусков для предпросмотра/);
    assert.match(preview, />Подписаться</);

    const related = renderToStaticMarkup(
        React.createElement(SimilarPodcasts, {
            podcasts: [
                {
                    id: "podcast-2",
                    title: "Web Rush",
                    author: "John Papa",
                    coverUrl: undefined,
                },
            ],
        }),
    );
    assert.match(related, /Похожее слушают/);
    assert.match(related, /Web Rush/);
});
