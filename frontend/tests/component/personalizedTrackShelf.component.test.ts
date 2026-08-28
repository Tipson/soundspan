import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
    played: [] as Array<{ tracks: unknown[]; index: number }>,
};

const Icon = () => React.createElement("svg");

mock.module("lucide-react", {
    namedExports: {
        Music: Icon,
        Play: Icon,
        Radio: Icon,
    },
});

mock.module("next/image", {
    defaultExport: ({ alt, src }: { alt?: string; src?: string }) =>
        React.createElement("img", { alt, src }),
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (url: string) => `/image-proxy/${url}`,
        },
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (tracks: unknown[], index: number) => {
                state.played.push({ tracks, index });
            },
        }),
    },
});

mock.module("@/components/ui/YouTubeBadge", {
    namedExports: {
        YouTubeBadge: () => React.createElement("span", null, "YT"),
    },
});

after(() => {
    try {
        GlobalRegistrator.unregister();
    } catch {
        // Best-effort teardown.
    }
});

beforeEach(() => {
    state.played.length = 0;
});

const tracks = [
    {
        id: "yt:video-a",
        title: "Alpha",
        duration: 201,
        trackNo: null,
        artist: { id: null, name: "Artist A" },
        album: {
            id: null,
            title: "Album A",
            coverArt: "https://img.example/a.jpg",
        },
        source: "youtube" as const,
        provider: { tidalTrackId: null, youtubeVideoId: "video-a" },
        streamSource: "youtube" as const,
        youtubeVideoId: "video-a",
    },
    {
        id: "yt:video-b",
        title: "Beta",
        duration: 189,
        trackNo: null,
        artist: { id: null, name: "Artist B" },
        album: {
            id: null,
            title: "Single",
            coverArt: null,
        },
        source: "youtube" as const,
        provider: { tidalTrackId: null, youtubeVideoId: "video-b" },
        streamSource: "youtube" as const,
        youtubeVideoId: "video-b",
    },
];

async function render(element: React.ReactElement): Promise<{
    container: HTMLElement;
    unmount: () => void;
}> {
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
        root.render(element);
    });
    return {
        container,
        unmount: () => {
            void React.act(() => root.unmount());
            container.remove();
        },
    };
}

test("personalized shelf plays the complete provider queue from the selected track", async () => {
    const { PersonalizedTrackShelf } =
        await import("../../features/home/components/PersonalizedTrackShelf");
    const { container, unmount } = await render(
        React.createElement(PersonalizedTrackShelf, {
            title: "Quick picks",
            subtitle: "Based on your likes",
            tracks,
        }),
    );

    assert.match(container.textContent ?? "", /Quick picks/);
    assert.match(container.textContent ?? "", /Based on your likes/);
    assert.match(container.textContent ?? "", /Alpha/);
    assert.match(container.textContent ?? "", /Artist B/);
    assert.match(container.innerHTML, /YT/);

    const beta = container.querySelector(
        'button[aria-label="Play Beta by Artist B"]',
    );
    assert.ok(beta, "playable Beta card not found");
    await React.act(async () => {
        (beta as HTMLButtonElement).click();
    });

    assert.equal(state.played.length, 1);
    assert.equal(state.played[0].index, 1);
    const queue = state.played[0].tracks as Array<{
        id: string;
        streamSource: string;
        youtubeVideoId: string;
        album: { coverArt?: string | null };
    }>;
    assert.equal(queue.length, 2);
    assert.equal(queue[0].id, "yt:video-a");
    assert.equal(queue[0].streamSource, "youtube");
    assert.equal(queue[0].youtubeVideoId, "video-a");
    assert.equal(queue[0].album.coverArt, "https://img.example/a.jpg");
    unmount();
});

test("personalized shelf renders no empty chrome", async () => {
    const { PersonalizedTrackShelf } =
        await import("../../features/home/components/PersonalizedTrackShelf");
    const { container, unmount } = await render(
        React.createElement(PersonalizedTrackShelf, {
            title: "Quick picks",
            tracks: [],
        }),
    );

    assert.equal(container.innerHTML, "");
    unmount();
});
