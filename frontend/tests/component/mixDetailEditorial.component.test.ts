import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
    writePlaybackReplacementIntent,
    recordExplicitPlaybackPause,
} from "../../lib/audio-engine/playbackAdvanceOrigin";
GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(async () => {
    await GlobalRegistrator.unregister();
});
const audio = {
    currentTrack: null as { id: string } | null,
    isPlaying: false,
    starts: [] as unknown[][],
    resumes: 0,
};
const tracks = [
    {
        id: "track-1",
        title: "Первый трек",
        duration: 180,
        albumId: "album-1",
        album: {
            title: "Альбом",
            coverUrl: null,
            artist: { id: "artist-1", name: "Исполнитель" },
        },
    },
    {
        id: "track-2",
        title: "Второй трек",
        duration: 200,
        albumId: "album-2",
        album: {
            title: "Другой альбом",
            coverUrl: null,
            artist: { id: "artist-2", name: "Исполнитель" },
        },
    },
];

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        Play: Icon,
        Pause: Icon,
        Music: Icon,
        Shuffle: Icon,
        Save: Icon,
        ListPlus: Icon,
        Loader2: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ id: "mix-1" }),
        useRouter: () => ({ push: () => undefined }),
    },
});

mock.module("next/image", {
    defaultExport: (props: Record<string, unknown>) =>
        React.createElement("img", {
            src: props.src as string,
            alt: props.alt as string,
        }),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => url,
            saveMixAsPlaylist: async () => ({ id: "saved", name: "Saved" }),
        },
    },
});

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({ currentTrack: audio.currentTrack }),
        usePlaybackStatus: () => ({ isPlaying: audio.isPlaying }),
        useAudioControls: () => ({
            playTracks: (...args: unknown[]) => {
                audio.starts.push(args);
                writePlaybackReplacementIntent(audio.currentTrack?.id ?? null);
            },
            addToQueue: () => undefined,
            pause: () => undefined,
            resume: () => {
                audio.resumes += 1;
            },
        }),
    },
});

mock.module("@/components/ui/CoverMosaic", {
    namedExports: {
        CoverMosaic: () =>
            React.createElement("div", { "data-cover-mosaic": true }),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("span", null, "spinner"),
    },
});

mock.module("sonner", {
    namedExports: {
        toast: {
            success: () => undefined,
            info: () => undefined,
            error: () => undefined,
        },
    },
});

mock.module("@/hooks/useQueries", {
    namedExports: {
        useMixQuery: () => ({
            data: {
                id: "mix-1",
                name: "Микс для долгой дороги с очень длинным названием",
                description: "Спокойная последовательность без повторов",
                trackCount: tracks.length,
                coverUrls: [],
                tracks,
            },
            isLoading: false,
        }),
    },
});

mock.module("@/hooks/useQueuedTrackIds", {
    namedExports: {
        useQueuedTrackIds: () => new Set<string>(),
    },
});

mock.module("@/hooks/usePlayButtonFeedback", {
    namedExports: {
        usePlayButtonFeedback: () => ({
            showSpinner: false,
            trigger: () => undefined,
        }),
    },
});

mock.module("@/lib/features-context", {
    namedExports: {
        useFeatures: () => ({ autoPlaylists: true, loading: false }),
    },
});

mock.module("@/lib/logger", {
    namedExports: {
        frontendLogger: {
            error: () => undefined,
        },
    },
});

mock.module("@/components/track", {
    namedExports: {
        TrackList: () =>
            React.createElement("div", { "data-mix-track-list": true }),
        TrackListHeader: () => null,
    },
});

test("generated mix follows the editorial hero, action dock, and canonical TrackRow contract", async () => {
    const MixPage = (await import("../../app/mix/[id]/page")).default;
    const html = renderToStaticMarkup(React.createElement(MixPage));
    const hero = html.match(
        /<header[^>]*data-music-detail="hero"[\s\S]*?<\/header>/,
    )?.[0];

    assert.ok(hero);
    assert.match(hero, /aria-label="Воспроизвести всё"/);
    assert.doesNotMatch(hero, />Слушать<|>Воспроизвести всё</);
    assert.match(hero, /data-music-detail="actions"/);
    assert.match(hero, /data-detail-action-tier="primary"/);
    assert.match(hero, /data-detail-action-tier="secondary"/);
    assert.match(hero, /Микс для долгой дороги/);
    assert.match(html, /data-music-detail="tracks"/);
    assert.match(html, /data-mix-track-list="true"/);

    for (const match of html.matchAll(/<button[^>]*>/g)) {
        assert.match(match[0], /(h-11 w-11|h-14 w-14|min-h-11)/);
    }
});

test("mix starts its own ordered queue over an identical foreign track and resumes after pause", async () => {
    const { createRoot } = await import("react-dom/client");
    const Page = (await import("../../app/mix/[id]/page")).default;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = () =>
        React.act(async () => {
            root.render(React.createElement(Page));
        });
    try {
        audio.currentTrack = { id: "track-1" };
        audio.isPlaying = true;
        writePlaybackReplacementIntent(null);
        await render();
        await React.act(async () =>
            host
                .querySelector<HTMLButtonElement>(
                    'button[aria-label="Воспроизвести всё"]',
                )!
                .click(),
        );
        assert.deepEqual(audio.starts.at(-1)?.[3], {
            replaceQueue: true,
            preserveOrder: true,
        });
        const count = audio.starts.length;
        audio.currentTrack = { id: "track-2" };
        audio.isPlaying = false;
        recordExplicitPlaybackPause();
        await render();
        await React.act(async () =>
            host
                .querySelector<HTMLButtonElement>(
                    'button[aria-label="Воспроизвести всё"]',
                )!
                .click(),
        );
        assert.equal(audio.resumes, 1);
        assert.equal(audio.starts.length, count);
    } finally {
        await React.act(async () => root.unmount());
        host.remove();
    }
});
