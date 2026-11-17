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
const impressions: unknown[][] = [];
const observers: Array<{
    callback: IntersectionObserverCallback;
    targets: Element[];
}> = [];
globalThis.IntersectionObserver = class {
    targets: Element[] = [];
    constructor(public callback: IntersectionObserverCallback) {
        observers.push(this);
    }
    observe(target: Element) {
        this.targets.push(target);
    }
    disconnect() {}
} as unknown as typeof IntersectionObserver;
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
        api: {
            getCoverArtUrl: (url: string) => `/cover/${url}`,
            reportRecommendationImpressions: async (...args: unknown[]) => {
                impressions.push(args);
            },
        },
    },
});

mock.module("@/lib/audio-controls-context", {
    namedExports: {
        useAudioControls: () => ({
            playTracks: (...args: unknown[]) => calls.push(args),
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
    impressions.length = 0;
    observers.length = 0;
    document.body.innerHTML = "";
});

test("snapshot refresh keeps its real date and does not replace a playing mix", async () => {
    const { PersonalizedMixCard } =
        await import("../../features/home/components/PersonalizedMixCard");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const firstTracks = [
        track("first", "First", null),
        track("second", "Second", null),
    ];
    const snapshot = {
        generatedAt: "2026-11-01T23:59:00.000Z",
        refreshAfter: "2026-11-02T00:09:00.000Z",
        requestedCount: 40,
        snapshotCount: 2,
        availableCount: 2,
        reasons: ["pool_limited"],
    };
    const props = {
        title: "Мой микс",
        description: "Знакомое и новые находки",
        tracks: firstTracks,
        tone: "violet" as const,
        index: 0,
        generationId: "original-snapshot",
        snapshot,
    };
    await act(async () =>
        root.render(React.createElement(PersonalizedMixCard, props)),
    );
    assert.equal(
        container.querySelector("time")?.getAttribute("datetime"),
        snapshot.generatedAt,
    );
    assert.match(container.textContent ?? "", /2 трека/);
    assert.match(container.textContent ?? "", /меньше подходящих треков/i);
    assert.equal(calls.length, 0);
    await act(async () => container.querySelector("button")?.click());
    assert.equal(calls.length, 1);
    await act(async () =>
        root.render(
            React.createElement(PersonalizedMixCard, {
                ...props,
                tracks: [track("new", "New", null)],
                generationId: "new-snapshot",
                snapshot: {
                    ...snapshot,
                    generatedAt: "2026-11-02T08:00:00.000Z",
                    availableCount: 1,
                },
            }),
        ),
    );
    assert.equal(calls.length, 1, "refetch must not dispatch playback");
    assert.deepEqual(
        (calls[0][0] as Array<{ id: string }>).map((t) => t.id),
        ["yt:first", "yt:second"],
    );
    assert.equal(
        container.querySelector("time")?.getAttribute("datetime"),
        "2026-11-02T08:00:00.000Z",
    );
    await act(async () =>
        root.render(
            React.createElement(PersonalizedMixCard, {
                ...props,
                snapshot: { ...snapshot, generatedAt: "not-a-date" },
            }),
        ),
    );
    assert.equal(
        container.querySelector("time"),
        null,
        "invalid metadata must not invent an update date",
    );
    assert.equal(calls.length, 1);
    await act(async () => root.unmount());
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

    const queue = calls[0][0] as Array<{
        id: string;
        youtubeVideoId: string;
        streamSource: string;
        recommendationGenerationId?: string;
    }>;
    assert.equal(calls[0][1], 0);
    assert.deepEqual(
        queue.map((t) => t.id),
        ["yt:one", "yt:two"],
    );
    assert.deepEqual(
        queue.map((t) => t.youtubeVideoId),
        ["one", "two"],
    );
    assert.ok(
        queue.every(
            (t) =>
                t.streamSource === "youtube" &&
                t.recommendationGenerationId === undefined,
        ),
    );

    await act(async () => root.unmount());
});

test("daily mix keeps attribution on all 40 playback entries and reports only visible artwork", async () => {
    const { PersonalizedMixCard } =
        await import("../../features/home/components/PersonalizedMixCard");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const tracks = Array.from({ length: 40 }, (_, i) =>
        track(`daily-${i}`, `Song ${i}`, `/daily-${i}.jpg`),
    );
    await act(async () =>
        root.render(
            React.createElement(PersonalizedMixCard, {
                title: "Дневной микс",
                description: "Подборка",
                tracks,
                tone: "violet",
                index: 0,
                generationId: "daily-generation",
            }),
        ),
    );
    assert.equal(impressions.length, 0);
    assert.equal(observers.length, 1);
    assert.equal(observers[0].targets.length, 4);
    await act(async () => {
        observers[0].callback(
            [
                { target: observers[0].targets[0], isIntersecting: true },
                { target: observers[0].targets[1], isIntersecting: false },
            ] as IntersectionObserverEntry[],
            {} as IntersectionObserver,
        );
        container
            .querySelector<HTMLButtonElement>(
                'button[aria-label="Воспроизвести: Дневной микс"]',
            )
            ?.click();
    });
    assert.deepEqual(impressions, [
        [
            "daily-generation",
            [{ provider: "youtube", providerTrackId: "daily-0" }],
        ],
    ]);
    const queue = calls[0][0] as Array<{
        youtubeVideoId: string;
        recommendationGenerationId: string;
        recommendationSessionId: string;
        recommendationQueueMode: string;
    }>;
    assert.equal(queue.length, 40);
    assert.deepEqual(
        queue.map((t) => t.youtubeVideoId),
        tracks.map((t) => t.youtubeVideoId),
    );
    assert.ok(
        queue.every((t) => t.recommendationGenerationId === "daily-generation"),
    );
    assert.ok(queue.every((t) => t.recommendationQueueMode === "finite"));
    assert.ok(
        queue.every(
            (t) =>
                t.recommendationSessionId === queue[0].recommendationSessionId,
        ),
    );
    assert.ok(queue[0].recommendationSessionId);
    await act(async () => root.unmount());
});
