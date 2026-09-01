import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = {
    isLoading: false,
    error: null as string | null,
    collection: {
        id: "mix-1",
        title: "Очень длинное название провайдерского микса для узкого экрана",
        trackCount: 2,
        thumbnailUrl: null,
        tracks: [
            {
                trackId: 1,
                title: "Track 1",
                artist: "Artist",
                artists: ["Artist"],
                album: "Album",
                duration: 180,
                isrc: null,
                thumbnailUrl: null,
            },
            {
                trackId: 2,
                title: "Track 2",
                artist: "Artist",
                artists: ["Artist"],
                album: "Album",
                duration: 200,
                isrc: null,
                thumbnailUrl: null,
            },
        ],
    },
};

const Icon = (props: Record<string, unknown> = {}) =>
    React.createElement("svg", props);

mock.module("lucide-react", {
    namedExports: {
        ArrowLeft: Icon,
        Play: Icon,
        Pause: Icon,
        Music2: Icon,
        ListMusic: Icon,
        Shuffle: Icon,
        Plus: Icon,
        Heart: Icon,
        Loader2: Icon,
    },
});

mock.module("next/navigation", {
    namedExports: {
        useParams: () => ({ id: "mix-1" }),
        useRouter: () => ({
            push: () => undefined,
            back: () => undefined,
        }),
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
            getTidalBrowseImageUrl: (url: string) => url,
        },
    },
});

mock.module("@/features/explore/hooks/useBrowseCollection", {
    namedExports: {
        useBrowseCollection: () => state,
    },
});

mock.module("@/features/explore/hooks/useBrowseCollectionActions", {
    namedExports: {
        useBrowseCollectionActions: () => ({
            isThisCollectionPlaying: false,
            isPlaying: false,
            showPlaySpinner: false,
            showPlaylistSelector: false,
            setShowPlaylistSelector: () => undefined,
            isAddingToPlaylist: false,
            likeableTracks: state.collection.tracks,
            isAllLiked: false,
            isApplyingLikeAll: false,
            toggleLikeAll: () => undefined,
            handleTogglePlay: () => undefined,
            handleAddToQueue: () => undefined,
            handleShuffle: () => undefined,
            handlePlaylistSelected: async () => undefined,
            handlePlayTrack: () => undefined,
        }),
    },
});

mock.module("@/features/explore/browseTrack", {
    namedExports: {
        BrowseTrackList: () =>
            React.createElement("div", { "data-provider-track-list": true }),
    },
});

mock.module("@/components/ui/GradientSpinner", {
    namedExports: {
        GradientSpinner: () => React.createElement("span", null, "spinner"),
    },
});

mock.module("@/components/ui/PlaylistSelector", {
    namedExports: {
        PlaylistSelector: () => null,
    },
});

beforeEach(() => {
    state.isLoading = false;
    state.error = null;
});

async function renderPage() {
    const { BrowseCollectionPage } =
        await import("@/features/explore/components/BrowseCollectionPage");
    return renderToStaticMarkup(
        React.createElement(BrowseCollectionPage, {
            kind: "mix",
            fetchCollection: async () => state.collection,
        }),
    );
}

test("provider collection uses one editorial hero, action hierarchy, and track surface", async () => {
    const html = await renderPage();
    const hero = html.match(
        /<header[^>]*data-music-detail="hero"[\s\S]*?<\/header>/,
    )?.[0];

    assert.ok(hero);
    assert.match(hero, /data-music-detail="actions"/);
    assert.match(hero, /data-detail-action-tier="primary"/);
    assert.match(hero, /data-detail-action-tier="secondary"/);
    assert.match(hero, /Очень длинное название провайдерского микса/);
    assert.match(html, /data-music-detail="tracks"/);
    assert.match(html, /data-provider-track-list="true"/);

    const buttons = [...html.matchAll(/<button[^>]*>/g)].map(
        (match) => match[0],
    );
    assert.ok(buttons.length >= 5);
    for (const button of buttons) {
        assert.match(button, /(h-11 w-11|min-h-11)/);
    }
});

test("provider loading and error states explain progress and recovery in Russian", async () => {
    state.isLoading = true;
    const loadingHtml = await renderPage();
    assert.match(loadingHtml, /Загружаем микс/);

    state.isLoading = false;
    state.error = "Микс временно недоступен";
    const errorHtml = await renderPage();
    assert.match(errorHtml, /role="alert"/);
    assert.match(errorHtml, /Микс временно недоступен/);
    const recoveryButton = errorHtml.match(
        /<button[^>]*>[^]*?Назад[^]*?<\/button>/,
    )?.[0];
    assert.ok(recoveryButton);
    assert.match(recoveryButton, /min-h-11/);
});
