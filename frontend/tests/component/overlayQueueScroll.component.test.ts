import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { QueueItem } from "@/lib/queue-item";
import { createRequire } from "node:module";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
after(() => GlobalRegistrator.unregister());

const scrolls: Array<{ index: number; behavior: string }> = [];
let reducedMotion = false;
const requireCjs = createRequire(`${process.cwd()}/package.json`);
const virtuosoMock = {
    namedExports: {
        Virtuoso: React.forwardRef(function VirtualList(_props: unknown, ref) {
            React.useImperativeHandle(ref, () => ({
                scrollToIndex: (value: { index: number; behavior: string }) =>
                    scrolls.push(value),
            }));
            return React.createElement(
                "div",
                { "data-testid": "virtual-scroll", tabIndex: 0 },
                "Queue viewport",
            );
        }),
    },
};
const motionMock = {
    namedExports: {
        useReducedMotion: () => reducedMotion,
        motion: {
            section: ({
                children,
                initial: _initial,
                animate: _animate,
                exit: _exit,
                transition: _transition,
                ...props
            }: Record<string, unknown>) =>
                React.createElement(
                    "section",
                    props,
                    children as React.ReactNode,
                ),
        },
    },
};
// tsx consumes these packages' CJS exports; Node's ESM module mock does not
// intercept that realization. Restore only the exact writable test seams.
const virtuosoCjs = requireCjs("react-virtuoso");
const motionCjs = requireCjs("framer-motion");
const originalVirtuoso = virtuosoCjs.Virtuoso;
const originalMotion = motionCjs.motion;
const originalReducedMotion = motionCjs.useReducedMotion;
virtuosoCjs.Virtuoso = virtuosoMock.namedExports.Virtuoso;
motionCjs.motion = motionMock.namedExports.motion;
motionCjs.useReducedMotion = motionMock.namedExports.useReducedMotion;
after(() => {
    virtuosoCjs.Virtuoso = originalVirtuoso;
    motionCjs.motion = originalMotion;
    motionCjs.useReducedMotion = originalReducedMotion;
});
mock.module("../../components/player/overlay-tabs/OverlayQueueRows", {
    namedExports: {
        OverlayQueueTrackRow: () => null,
        OverlayQueueEpisodeRow: () => null,
    },
});
beforeEach(() => {
    scrolls.length = 0;
    reducedMotion = false;
});

async function mount() {
    const { createRoot } = await import("react-dom/client");
    const { OverlayQueueTab } =
        await import("../../components/player/overlay-tabs/OverlayQueueTab");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queue = Array.from({ length: 60 }, (_, index) => ({
        id: `track-${index}`,
        title: `Track ${index}`,
        duration: 180,
    })) as QueueItem[];
    async function render(index: number, tracks = queue) {
        await React.act(async () =>
            root.render(
                React.createElement(OverlayQueueTab, {
                    queueTracks: tracks,
                    currentIndex: index,
                    onPlayFromQueue: () => {},
                    onRemoveFromQueue: () => {},
                    onClearQueue: () => {},
                }),
            ),
        );
    }
    await render(0);
    return {
        container,
        queue,
        render,
        async close() {
            await React.act(async () => root.unmount());
            container.remove();
        },
    };
}

for (const intent of [
    "wheel",
    "pointerdown",
    "touchmove",
    "keydown",
] as const) {
    test(`manual ${intent} browsing is not interrupted by advancing playback`, async () => {
        const view = await mount();
        try {
            const viewport = view.container.querySelector(
                '[data-testid="virtual-scroll"]',
            )!;
            assert.ok(viewport, view.container.innerHTML);
            const event =
                intent === "wheel"
                    ? new WheelEvent(intent, { bubbles: true, deltaY: 120 })
                    : intent === "keydown"
                      ? new KeyboardEvent(intent, {
                            bubbles: true,
                            key: "PageDown",
                        })
                      : new Event(intent, { bubbles: true });
            await React.act(async () => viewport.dispatchEvent(event));
            await view.render(1);
            assert.equal(
                scrolls.length,
                0,
                "current-track updates must not override manual browsing",
            );
            const back = Array.from(
                view.container.querySelectorAll("button"),
            ).find(
                (button) =>
                    button.getAttribute("aria-label") ===
                    "Вернуться к текущему треку",
            );
            assert.ok(back);
            await React.act(async () => back.click());
            assert.equal(scrolls.at(-1)?.index, 1);
            scrolls.length = 0;
            await view.render(2);
            assert.equal(
                scrolls.at(-1)?.index,
                2,
                "explicit return restores follow mode",
            );
        } finally {
            await view.close();
        }
    });
}

test("appending Wave candidates and refreshing metadata never recenters the queue", async () => {
    const view = await mount();
    try {
        await view.render(0, [
            ...view.queue,
            { id: "added", title: "New candidate", duration: 180 } as QueueItem,
        ]);
        await view.render(
            0,
            view.queue.map((track) => ({
                ...track,
                title: `Refreshed ${track.id}`,
            })),
        );
        assert.deepEqual(scrolls, []);
    } finally {
        await view.close();
    }
});

test("automatic follow still works before interaction and honors reduced motion", async () => {
    reducedMotion = true;
    const view = await mount();
    try {
        await view.render(1);
        assert.deepEqual(scrolls, [
            { index: 1, align: "center", behavior: "auto" },
        ]);
    } finally {
        await view.close();
    }
});
