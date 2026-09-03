import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = {
    signal: "clear" as "thumbs_up" | "thumbs_down" | "clear",
    isSaving: false,
    toggleLikeCalls: 0,
    toggleDislikeCalls: 0,
    dislikeResultSignal: "thumbs_down" as "thumbs_up" | "thumbs_down" | "clear",
};

mock.module("lucide-react", {
    namedExports: {
        Heart: (props: Record<string, unknown>) =>
            React.createElement("svg", {
                ...props,
                "data-icon": props["data-icon"] ?? "heart-outline",
            }),
        ThumbsDown: (props: Record<string, unknown>) =>
            React.createElement("svg", props),
    },
});

mock.module("@/hooks/useTrackPreference", {
    namedExports: {
        buildPreferenceMetadata: () => undefined,
        useTrackPreference: () => ({
            signal: state.signal,
            isSaving: state.isSaving,
            toggleLike: async () => {
                state.toggleLikeCalls += 1;
            },
            toggleDislike: async () => {
                state.toggleDislikeCalls += 1;
                return {
                    trackId: "track-interactive",
                    signal: state.dislikeResultSignal,
                    score: state.dislikeResultSignal === "thumbs_down" ? -1 : 0,
                    isLiked: false,
                    isDisliked: state.dislikeResultSignal === "thumbs_down",
                    likedAt: null,
                    dislikedAt:
                        state.dislikeResultSignal === "thumbs_down"
                            ? "2026-08-29T00:00:00.000Z"
                            : null,
                };
            },
        }),
    },
});

mock.module("@/utils/cn", {
    namedExports: {
        cn: (...values: Array<string | false | null | undefined>) =>
            values.filter(Boolean).join(" "),
    },
});

beforeEach(() => {
    state.signal = "clear";
    state.isSaving = false;
    state.toggleLikeCalls = 0;
    state.toggleDislikeCalls = 0;
    state.dislikeResultSignal = "thumbs_down";
});

afterEach(() => {
    document.body.innerHTML = "";
});

test("renders like control without circular chrome", async () => {
    const { TrackPreferenceButtons } =
        await import("../../components/player/TrackPreferenceButtons");
    const html = renderToStaticMarkup(
        React.createElement(TrackPreferenceButtons, { trackId: "track-1" }),
    );

    assert.match(html, /data-icon="heart-outline"/);
    assert.doesNotMatch(html, /data-icon="thumbs-down-outline"/);
    assert.match(html, /h-11 w-11/);
    assert.match(html, /h-6 w-6/);
    assert.match(html, /rounded-xl/);
    assert.match(html, /focus-visible:ring-brand/);
    assert.doesNotMatch(html, /rounded-full/);
    assert.doesNotMatch(html, /\bborder\b/);
});

test("active signal renders a filled heart icon", async () => {
    state.signal = "thumbs_up";

    const { TrackPreferenceButtons } =
        await import("../../components/player/TrackPreferenceButtons");
    const html = renderToStaticMarkup(
        React.createElement(TrackPreferenceButtons, { trackId: "track-2" }),
    );

    assert.match(html, /data-icon="heart-filled"/);
    assert.doesNotMatch(html, /data-icon="heart-outline"/);
});

test("preference controls remain toggleable while an earlier request is saving", async () => {
    state.signal = "thumbs_up";
    state.isSaving = true;

    const { TrackPreferenceButtons } =
        await import("../../components/player/TrackPreferenceButtons");
    const html = renderToStaticMarkup(
        React.createElement(TrackPreferenceButtons, {
            trackId: "track-saving",
            mode: "both",
        }),
    );

    assert.match(html, /aria-label="Убрать отметку «Нравится»"/);
    assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /disabled=""/);
});

test("both mode renders accessible like and dislike controls", async () => {
    const { TrackPreferenceButtons } =
        await import("../../components/player/TrackPreferenceButtons");
    const html = renderToStaticMarkup(
        React.createElement(TrackPreferenceButtons, {
            trackId: "track-both",
            mode: "both",
        }),
    );

    assert.match(html, /aria-label="Нравится"/);
    assert.match(html, /aria-label="Не нравится"/);
    assert.match(html, /title="Нравится"/);
    assert.match(html, /title="Не нравится"/);
    assert.match(html, /data-icon="thumbs-down-outline"/);
    assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 2);
});

test("down-only mode omits the like control", async () => {
    const { TrackPreferenceButtons } =
        await import("../../components/player/TrackPreferenceButtons");
    const html = renderToStaticMarkup(
        React.createElement(TrackPreferenceButtons, {
            trackId: "track-down-only",
            mode: "down-only",
        }),
    );

    assert.doesNotMatch(html, /aria-label="Нравится"/);
    assert.match(html, /aria-label="Не нравится"/);
});

test("active dislike is pressed and offers to remove the dislike", async () => {
    state.signal = "thumbs_down";

    const { TrackPreferenceButtons } =
        await import("../../components/player/TrackPreferenceButtons");
    const html = renderToStaticMarkup(
        React.createElement(TrackPreferenceButtons, {
            trackId: "track-disliked",
            mode: "both",
        }),
    );

    assert.match(html, /aria-label="Убрать отметку «Не нравится»"/);
    assert.match(html, /title="Убрать отметку «Не нравится»"/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /data-icon="thumbs-down-filled"/);
});

test("notifies Wave only after the dislike mutation is confirmed", async () => {
    const { TrackPreferenceButtons } =
        await import("../../components/player/TrackPreferenceButtons");
    const appliedTrackIds: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(
            React.createElement(TrackPreferenceButtons, {
                trackId: "track-interactive",
                mode: "both",
                onThumbsDownApplied: (trackId: string) =>
                    appliedTrackIds.push(trackId),
            }),
        );
    });
    const dislikeButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Не нравится"]',
    );
    assert.ok(dislikeButton);

    await act(async () => dislikeButton.click());
    assert.equal(state.toggleDislikeCalls, 1);
    assert.deepEqual(appliedTrackIds, ["track-interactive"]);

    await act(async () => root.unmount());
});

test("removing an existing dislike does not advance Wave", async () => {
    state.signal = "thumbs_down";
    state.dislikeResultSignal = "clear";
    const { TrackPreferenceButtons } =
        await import("../../components/player/TrackPreferenceButtons");
    const appliedTrackIds: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(
            React.createElement(TrackPreferenceButtons, {
                trackId: "track-interactive",
                mode: "both",
                onThumbsDownApplied: (trackId: string) =>
                    appliedTrackIds.push(trackId),
            }),
        );
    });
    const dislikeButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Убрать отметку «Не нравится»"]',
    );
    assert.ok(dislikeButton);

    await act(async () => dislikeButton.click());
    assert.equal(state.toggleDislikeCalls, 1);
    assert.deepEqual(appliedTrackIds, []);

    await act(async () => root.unmount());
});
