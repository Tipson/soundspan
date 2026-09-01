import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const calls: unknown[][] = [];
const Icon = () => React.createElement("i");

mock.module("lucide-react", {
    namedExports: { Music2: Icon, Play: Icon },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: ({ alt }: { alt: string }) =>
            React.createElement("img", { alt }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: { getCoverArtUrl: (url: string) => `/cover/${url}` },
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (...args: unknown[]) => calls.push(args),
        }),
    },
});

mock.module("@/lib/audio/providerRadioContinuation", {
    namedExports: {
        toProviderPlaybackTrack: (track: { id: string; title: string }) => ({
            id: track.id,
            title: track.title,
        }),
    },
});

const track = (id: string, title: string, coverArt: string | null) => ({
    id,
    title,
    duration: 180,
    trackNo: null,
    artist: { id: null, name: "Artist" },
    album: { id: null, title: "Album", coverArt },
    source: "youtube" as const,
    provider: { tidalTrackId: null, youtubeVideoId: id },
    streamSource: "youtube" as const,
    youtubeVideoId: id,
});

beforeEach(() => {
    calls.length = 0;
    document.body.innerHTML = "";
});

test("personalized mix card renders real shelf artwork and starts its complete queue", async () => {
    const { PersonalizedMixCard } =
        await import("../../features/home/components/PersonalizedMixCard");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const tracks = [
        track("one", "One", "/one.jpg"),
        track("two", "Two", "/two.jpg"),
    ];

    await act(async () => {
        root.render(
            React.createElement(PersonalizedMixCard, {
                title: "Fresh finds",
                description: "New music shaped by your listening",
                tracks,
                tone: "blue",
                index: 2,
            }),
        );
    });

    assert.equal(
        container.querySelectorAll("[data-personal-mix-cover]").length,
        2,
    );
    assert.match(container.textContent ?? "", /Fresh finds/);
    assert.match(container.textContent ?? "", /2 трека/);
    assert.equal(
        container.querySelector("button")?.getAttribute("data-tv-card-index"),
        "2",
    );

    await act(async () => {
        container
            .querySelector<HTMLButtonElement>(
                'button[aria-label="Воспроизвести: Fresh finds"]',
            )
            ?.click();
    });

    assert.deepEqual(calls[0], [
        [
            { id: "one", title: "One" },
            { id: "two", title: "Two" },
        ],
        0,
    ]);

    await act(async () => root.unmount());
});
