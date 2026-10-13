import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import React from "react";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const state = { visible: true, mobile: true, height: 68 };
const ownerHeights = new Map<string, number>();
const observers: FakeObserver[] = [];
class FakeObserver {
    target: Element | null = null;
    disconnected = false;
    constructor(private readonly callback: ResizeObserverCallback) {
        observers.push(this);
    }
    observe(target: Element) {
        this.target = target;
    }
    disconnect() {
        this.disconnected = true;
    }
    fire() {
        this.callback(
            [{ target: this.target } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
        );
    }
}
const previousObserver = globalThis.ResizeObserver;
const originalRect = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function () {
    const rect = originalRect.call(this);
    if (this.getAttribute("data-mobile-player") !== "dock") return rect;
    const owner =
        this.closest("[data-height-owner]")?.getAttribute(
            "data-height-owner",
        ) ?? "";
    return {
        ...rect,
        height: ownerHeights.get(owner) ?? state.height,
    } as DOMRect;
};

mock.module("@/lib/audio-context", {
    namedExports: {
        useAudioState: () => ({
            currentTrack: { id: "height-track", title: "Track" },
            currentAudiobook: null,
            currentPodcast: null,
            playbackType: "track",
        }),
        usePlaybackStatus: () => ({
            isPlaying: false,
            isBuffering: false,
            duration: 180,
            audioError: null,
            clearAudioError: () => undefined,
        }),
        useAudioControls: () => ({
            pause: () => undefined,
            resume: () => undefined,
            setPlayerMode: () => undefined,
        }),
    },
});
mock.module("@/lib/audio-playback-context", {
    namedExports: { usePlaybackProgress: () => ({ currentTime: 0 }) },
});
mock.module("@/hooks/useMediaInfo", {
    namedExports: {
        useMediaInfo: () => ({
            title: "Track",
            subtitle: "Artist",
            coverUrl: null,
            hasMedia: state.visible,
        }),
    },
});
mock.module("@/hooks/useMediaQuery", {
    namedExports: { useIsMobile: () => state.mobile, useIsTablet: () => false },
});
mock.module("@/hooks/useTrackPreference", {
    namedExports: { buildPreferenceMetadata: () => undefined },
});
mock.module("@/components/player/CurrentTrackPreferenceButtons", {
    namedExports: { CurrentTrackPreferenceButtons: () => null },
});
mock.module("@/components/ui/CachedImage", {
    namedExports: { CachedImage: () => null },
});
mock.module("framer-motion", {
    namedExports: {
        useReducedMotion: () => true,
        motion: {
            div: ({
                children,
                layoutId: _layoutId,
                transition: _transition,
                ...props
            }: {
                children?: React.ReactNode;
                [key: string]: unknown;
            }) => React.createElement("div", props, children),
        },
    },
});

beforeEach(() => {
    state.visible = true;
    state.mobile = true;
    state.height = 68;
    ownerHeights.clear();
    observers.length = 0;
    globalThis.ResizeObserver =
        FakeObserver as unknown as typeof ResizeObserver;
});
after(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    globalThis.ResizeObserver = previousObserver;
    GlobalRegistrator.unregister();
});

async function mounted(prior?: string, priority = "") {
    const { createRoot } = await import("react-dom/client");
    const { MiniPlayer } = await import("../../components/player/MiniPlayer");
    const shell = document.createElement("section");
    shell.className = "mobile-shell-frame";
    if (prior)
        shell.style.setProperty("--app-mini-player-inset", prior, priority);
    const container = document.createElement("div");
    shell.append(container);
    document.body.append(shell);
    const root = createRoot(container);
    const render = async (old = true, next = false) => {
        await React.act(async () => {
            root.render(
                React.createElement(
                    React.Fragment,
                    null,
                    old
                        ? React.createElement(
                              "div",
                              { key: "old", "data-height-owner": "old" },
                              React.createElement(MiniPlayer),
                          )
                        : null,
                    next
                        ? React.createElement(
                              "div",
                              { key: "new", "data-height-owner": "new" },
                              React.createElement(MiniPlayer),
                          )
                        : null,
                ),
            );
        });
    };
    await render();
    const close = async () => {
        await React.act(async () => root.unmount());
        shell.remove();
    };
    return { shell, render, close };
}
const inset = (shell: HTMLElement) =>
    shell.style.getPropertyValue("--app-mini-player-inset");

test("MiniPlayer measures its mounted dock, grows and shrinks without a fixed extra reserve", async () => {
    const m = await mounted("19px", "important");
    try {
        assert.equal(inset(m.shell), "68px");
        assert.equal(observers.length, 1);
        assert.equal(
            observers[0].target,
            m.shell.querySelector('[data-mobile-player="dock"]'),
        );
        state.height = 112;
        observers[0].fire();
        assert.equal(inset(m.shell), "112px");
        state.height = 91.5;
        observers[0].fire();
        assert.equal(inset(m.shell), "91.5px");
        state.height = 68;
        observers[0].fire();
        assert.equal(inset(m.shell), "68px");
    } finally {
        await m.close();
    }
    assert.equal(inset(m.shell), "19px");
    assert.equal(
        m.shell.style.getPropertyPriority("--app-mini-player-inset"),
        "important",
    );
    assert.ok(observers[0].disconnected);
});

test("hide removes the inline inset and late old callbacks cannot overwrite a newly shown player", async () => {
    const m = await mounted();
    try {
        assert.equal(inset(m.shell), "68px");
        const old = observers[0];
        state.visible = false;
        await m.render();
        assert.equal(inset(m.shell), "");
        assert.ok(old.disconnected);
        state.height = 210;
        old.fire();
        assert.equal(inset(m.shell), "");
        state.visible = true;
        state.height = 74;
        await m.render();
        assert.equal(inset(m.shell), "74px");
        old.fire();
        assert.equal(inset(m.shell), "74px");
    } finally {
        await m.close();
    }
});

test("an outgoing player's cleanup preserves the incoming player's measurement and original baseline", async () => {
    ownerHeights.set("old", 68);
    ownerHeights.set("new", 112);
    const m = await mounted("23px", "important");
    try {
        assert.equal(inset(m.shell), "68px");
        const old = observers[0];
        await m.render(true, true);
        assert.equal(inset(m.shell), "112px");
        const current = observers[1];
        await m.render(false, true);
        assert.ok(old.disconnected);
        assert.equal(inset(m.shell), "112px");
        old.fire();
        assert.equal(inset(m.shell), "112px");
        ownerHeights.set("new", 68);
        current.fire();
        assert.equal(inset(m.shell), "68px");
    } finally {
        await m.close();
    }
    assert.equal(inset(m.shell), "23px");
    assert.equal(
        m.shell.style.getPropertyPriority("--app-mini-player-inset"),
        "important",
    );
});

test("disconnected docks ignore resize callbacks and unmount still restores the previous property", async () => {
    const m = await mounted("15px");
    try {
        assert.equal(inset(m.shell), "68px");
        m.shell.remove();
        state.height = 200;
        observers[0].fire();
        assert.equal(inset(m.shell), "68px");
    } finally {
        await m.close();
    }
    assert.equal(inset(m.shell), "15px");
});

test("without ResizeObserver the initial measurement and cleanup still work", async () => {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
    const m = await mounted();
    try {
        assert.equal(inset(m.shell), "68px");
        assert.equal(observers.length, 0);
    } finally {
        await m.close();
    }
    assert.equal(inset(m.shell), "");
});

test("invalid measurements are ignored until a finite positive dock height arrives", async () => {
    state.height = 0;
    const m = await mounted("17px");
    try {
        assert.equal(inset(m.shell), "17px");
        state.height = 112;
        observers[0].fire();
        assert.equal(inset(m.shell), "112px");
        for (const height of [NaN, Infinity, -1, 0]) {
            state.height = height;
            observers[0].fire();
            assert.equal(inset(m.shell), "112px");
        }
    } finally {
        await m.close();
    }
});

test("switching to desktop hides the mini player and releases its reservation", async () => {
    const m = await mounted();
    try {
        assert.equal(inset(m.shell), "68px");
        state.mobile = false;
        await m.render();
        assert.equal(inset(m.shell), "");
        assert.ok(observers[0].disconnected);
    } finally {
        await m.close();
    }
});

test("server rendering creates no observer or geometry reservation", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MiniPlayer } = await import("../../components/player/MiniPlayer");
    assert.match(
        renderToStaticMarkup(React.createElement(MiniPlayer)),
        /data-mobile-player="dock"/,
    );
    assert.equal(observers.length, 0);
});
