import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const calls = {
    playTracks: [] as unknown[][],
    isShuffle: [] as unknown[],
    shuffleIndices: [] as unknown[][],
    vibeMode: [] as unknown[],
    vibeQueueIds: [] as unknown[][],
    vibeSourceFeatures: [] as unknown[],
    waveMode: [] as unknown[],
};

const Icon = () => React.createElement("i");

mock.module("lucide-react", {
    namedExports: {
        AudioWaveform: Icon,
        ChevronRight: Icon,
        Play: Icon,
    },
});

mock.module("@/components/ui/CachedImage", {
    namedExports: {
        CachedImage: ({ alt }: { alt: string }) =>
            React.createElement("img", { alt }),
    },
});

mock.module("@/lib/api", {
    namedExports: {
        api: {
            getCoverArtUrl: (value: string) => value,
        },
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (...args: unknown[]) => calls.playTracks.push(args),
        }),
    },
});

mock.module("@/lib/audio-state-context", {
    namedExports: {
        useAudioState: () => ({
            setIsShuffle: (value: unknown) => calls.isShuffle.push(value),
            setShuffleIndices: (value: unknown[]) =>
                calls.shuffleIndices.push(value),
            setVibeMode: (value: unknown) => calls.vibeMode.push(value),
            setVibeQueueIds: (value: unknown[]) =>
                calls.vibeQueueIds.push(value),
            setVibeSourceFeatures: (value: unknown) =>
                calls.vibeSourceFeatures.push(value),
            setWaveMode: (value: unknown) => calls.waveMode.push(value),
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

const track = (id: string, title: string, coverArt: string | null = null) => ({
    id,
    title,
    duration: 180,
    trackNo: null,
    artist: { id: null, name: "Artist" },
    album: { id: null, title: "Single", coverArt },
    source: "youtube" as const,
    provider: { tidalTrackId: null, youtubeVideoId: id },
    streamSource: "youtube" as const,
    youtubeVideoId: id,
});

beforeEach(() => {
    calls.playTracks.length = 0;
    calls.isShuffle.length = 0;
    calls.shuffleIndices.length = 0;
    calls.vibeMode.length = 0;
    calls.vibeQueueIds.length = 0;
    calls.vibeSourceFeatures.length = 0;
    calls.waveMode.length = 0;
});

afterEach(() => {
    document.body.innerHTML = "";
});

test("home Wave hero starts a balanced personalized queue as Vibe", async () => {
    const { HomeWaveHero } =
        await import("../../features/home/components/HomeWaveHero");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(
            React.createElement(HomeWaveHero, {
                personalizedFeed: {
                    shelves: {
                        quickPicks: [track("quick", "Quick", "/quick.jpg")],
                        discovery: [track("fresh", "Fresh", "/fresh.jpg")],
                        listenAgain: [track("again", "Again", "/again.jpg")],
                    },
                    degraded: false,
                    reason: null,
                    seedCount: 3,
                },
                isLoading: false,
            }),
        );
    });

    const playButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Включить мою волну"]',
    );
    assert.ok(playButton);
    assert.ok(container.querySelector('[data-home-wave-layout="launch"]'));
    assert.equal(container.querySelectorAll("[data-wave-cover]").length, 3);

    await act(async () => {
        playButton.click();
    });

    assert.deepEqual(
        (calls.playTracks[0]?.[0] as Array<{ id: string }>).map(
            (item) => item.id,
        ),
        ["quick", "fresh", "again"],
    );
    assert.deepEqual(calls.playTracks[0]?.slice(1), [0, true]);
    assert.deepEqual(calls.isShuffle, [false]);
    assert.deepEqual(calls.shuffleIndices, [[]]);
    assert.deepEqual(calls.vibeMode, [true]);
    assert.deepEqual(calls.vibeSourceFeatures, [null]);
    assert.deepEqual(calls.vibeQueueIds, [["quick", "fresh", "again"]]);
    assert.deepEqual(calls.waveMode, ["for-you"]);
    assert.doesNotMatch(container.textContent ?? "", /tracks ready/i);
    assert.match(container.textContent ?? "", /Моя волна/i);
    assert.match(container.textContent ?? "", /Настроить/i);
    assert.doesNotMatch(container.textContent ?? "", /Press play/i);
    assert.doesNotMatch(
        container.textContent ?? "",
        /Familiar favorites and new discoveries/i,
    );

    await act(async () => root.unmount());
});

test("home Wave hero keeps play disabled while no recommendations are ready", async () => {
    const { HomeWaveHero } =
        await import("../../features/home/components/HomeWaveHero");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(
            React.createElement(HomeWaveHero, {
                personalizedFeed: null,
                isLoading: true,
            }),
        );
    });

    const playButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Включить мою волну"]',
    );
    assert.ok(playButton?.disabled);
    assert.match(container.textContent ?? "", /Настраиваем мою волну/);

    await act(async () => root.unmount());
});
