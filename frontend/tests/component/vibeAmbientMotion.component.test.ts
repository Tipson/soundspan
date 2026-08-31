import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let desktopMatches = true;

before(() => {
    GlobalRegistrator.register();
    Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1440,
    });
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({
            matches: query === "(min-width: 1025px)" ? desktopMatches : false,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => true,
        }),
    });
    (
        globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
});

function installCanvasMotionSpies() {
    const contextDescriptor = Object.getOwnPropertyDescriptor(
        HTMLCanvasElement.prototype,
        "getContext",
    );
    const boundsDescriptor = Object.getOwnPropertyDescriptor(
        HTMLCanvasElement.prototype,
        "getBoundingClientRect",
    );
    const frameDescriptor = Object.getOwnPropertyDescriptor(
        window,
        "requestAnimationFrame",
    );
    const cancelFrameDescriptor = Object.getOwnPropertyDescriptor(
        window,
        "cancelAnimationFrame",
    );
    const calls = { cancellations: 0, contexts: 0, frames: 0, strokes: 0 };
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    const context = {
        beginPath() {},
        clearRect() {},
        lineTo() {},
        moveTo() {},
        restore() {},
        save() {},
        setTransform() {},
        stroke() {
            calls.strokes += 1;
        },
    } as unknown as CanvasRenderingContext2D;

    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        configurable: true,
        value: () => {
            calls.contexts += 1;
            return context;
        },
    });
    Object.defineProperty(
        HTMLCanvasElement.prototype,
        "getBoundingClientRect",
        {
            configurable: true,
            value: () => ({
                bottom: 360,
                height: 360,
                left: 0,
                right: 1280,
                top: 0,
                width: 1280,
                x: 0,
                y: 0,
                toJSON() {},
            }),
        },
    );
    Object.defineProperty(window, "requestAnimationFrame", {
        configurable: true,
        value: (callback: FrameRequestCallback) => {
            calls.frames += 1;
            frameCallbacks.set(calls.frames, callback);
            return calls.frames;
        },
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
        configurable: true,
        value: (frameId: number) => {
            calls.cancellations += 1;
            frameCallbacks.delete(frameId);
        },
    });

    return {
        calls,
        runNextFrame(timestamp: number) {
            const next = frameCallbacks.entries().next().value as
                | [number, FrameRequestCallback]
                | undefined;
            assert.ok(next, "expected a scheduled animation frame");
            frameCallbacks.delete(next[0]);
            next[1](timestamp);
        },
        restore() {
            if (contextDescriptor) {
                Object.defineProperty(
                    HTMLCanvasElement.prototype,
                    "getContext",
                    contextDescriptor,
                );
            }
            if (boundsDescriptor) {
                Object.defineProperty(
                    HTMLCanvasElement.prototype,
                    "getBoundingClientRect",
                    boundsDescriptor,
                );
            }
            if (frameDescriptor) {
                Object.defineProperty(
                    window,
                    "requestAnimationFrame",
                    frameDescriptor,
                );
            }
            if (cancelFrameDescriptor) {
                Object.defineProperty(
                    window,
                    "cancelAnimationFrame",
                    cancelFrameDescriptor,
                );
            }
        },
    };
}

after(() => {
    GlobalRegistrator.unregister();
});

test("Vibe ambient canvas exposes an honest analyzed or fallback motion state", async () => {
    desktopMatches = true;
    const { VibeAmbientMotion } =
        await import("../../components/vibe/VibeAmbientMotion");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(
                React.createElement(VibeAmbientMotion, {
                    trackId: "local:analyzed",
                    bpm: 128,
                    energy: 0.7,
                    mode: "for-you",
                    mood: null,
                    isPlaying: false,
                }),
            );
        });

        const canvas = container.querySelector("canvas");
        assert.ok(canvas);
        assert.equal(canvas.getAttribute("aria-hidden"), "true");
        assert.equal(canvas.dataset.motionTempoSource, "analyzed");
        assert.equal(canvas.dataset.motionEnergySource, "analyzed");
        assert.equal(canvas.dataset.motionState, "paused");

        await React.act(async () => {
            root.render(
                React.createElement(VibeAmbientMotion, {
                    trackId: "yt:provider",
                    bpm: null,
                    energy: null,
                    mode: "new",
                    mood: "energetic",
                    isPlaying: false,
                }),
            );
        });

        assert.equal(
            canvas.dataset.motionTempoSource,
            "deterministic-fallback",
        );
        assert.equal(
            canvas.dataset.motionEnergySource,
            "deterministic-fallback",
        );
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
    }
});

test("Vibe ambient motion never initializes or schedules frames below the desktop breakpoint", async () => {
    desktopMatches = false;
    const spies = installCanvasMotionSpies();
    const { VibeAmbientMotion } =
        await import("../../components/vibe/VibeAmbientMotion");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
        await React.act(async () => {
            root.render(
                React.createElement(VibeAmbientMotion, {
                    trackId: "yt:compact",
                    bpm: 140,
                    energy: 0.9,
                    mode: "for-you",
                    mood: "workout",
                    isPlaying: true,
                }),
            );
        });

        const canvas = container.querySelector("canvas");
        assert.ok(canvas);
        assert.match(canvas.className, /(?:^|\s)hidden(?:\s|$)/);
        assert.match(canvas.className, /min-\[1025px\]:block/);
        assert.equal(canvas.dataset.motionState, "compact-static");
        assert.equal(spies.calls.contexts, 0);
        assert.equal(spies.calls.frames, 0);
    } finally {
        await React.act(async () => root.unmount());
        container.remove();
        spies.restore();
        desktopMatches = true;
    }
});

test("Vibe ambient desktop motion draws, reschedules and cancels across playback lifecycle", async () => {
    desktopMatches = true;
    const spies = installCanvasMotionSpies();
    const { VibeAmbientMotion } =
        await import("../../components/vibe/VibeAmbientMotion");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let unmounted = false;

    const renderMotion = (isPlaying: boolean) =>
        React.createElement(VibeAmbientMotion, {
            trackId: "yt:desktop",
            bpm: 128,
            energy: 0.7,
            mode: "for-you" as const,
            mood: null,
            isPlaying,
        });

    try {
        await React.act(async () => {
            root.render(renderMotion(true));
        });

        const canvas = container.querySelector("canvas");
        assert.ok(canvas);
        assert.equal(canvas.dataset.motionState, "playing");
        assert.ok(spies.calls.contexts > 0);
        assert.equal(spies.calls.frames, 1);
        const initialStrokes = spies.calls.strokes;

        await React.act(async () => spies.runNextFrame(100));
        assert.equal(spies.calls.frames, 2);
        await React.act(async () => spies.runNextFrame(150));
        assert.equal(spies.calls.frames, 3);
        assert.ok(spies.calls.strokes > initialStrokes);

        await React.act(async () => root.render(renderMotion(false)));
        assert.equal(canvas.dataset.motionState, "paused");
        assert.equal(spies.calls.frames, 3);
        assert.equal(spies.calls.cancellations, 1);

        await React.act(async () => root.render(renderMotion(true)));
        assert.equal(spies.calls.frames, 4);
        await React.act(async () => root.unmount());
        unmounted = true;
        assert.equal(spies.calls.cancellations, 2);
    } finally {
        if (!unmounted) await React.act(async () => root.unmount());
        container.remove();
        spies.restore();
    }
});
